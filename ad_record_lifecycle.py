"""Reviewed archive, restore and guarded deletion for advertiser records."""
from datetime import datetime, timezone
import re

from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from ad_drafts import _authorize, _id, _wire
from ad_publish import HISTORY, _digest
from cloud_function_core import CallableAccessError

COLLECTIONS = {'sponsor': 'sponsors', 'campaign': 'campaigns',
               'creative': 'creatives', 'draft': 'ad_drafts'}
CHILDREN = {'sponsor': [('campaigns', 'sponsor_id')],
            'campaign': [('creatives', 'campaign_id')]}
REPORTS = {'campaign': 'campaign_id', 'creative': 'creative_id'}


def _matches(client, tx, collection, field, identifier):
    return list(client.collection(collection).where(
        filter=FieldFilter(field, '==', identifier)).limit(1).stream(transaction=tx))


def manage_ad_record(client, auth, app, data, web_app_id, now=None, *, environment='test'):
    uid = _authorize(client, auth, app, web_app_id, environment=environment)
    action = data.get('action') if isinstance(data, dict) else None
    if (action not in ('prepare', 'archive', 'restore', 'delete')
            or set(data) != ({'action', 'kind', 'target_id', 'operation'} if action == 'prepare'
                             else {'action', 'kind', 'target_id', 'confirmation'})
            or data.get('kind') not in COLLECTIONS or not _id(data.get('target_id'))
            or action == 'prepare' and data.get('operation') not in ('archive', 'restore', 'delete')
            or action != 'prepare' and (not isinstance(data.get('confirmation'), str)
                or not re.fullmatch('[0-9a-f]{64}', data['confirmation']))):
        raise ValueError('Choose a record and review its archive, restore, or deletion.')
    operation = data['operation'] if action == 'prepare' else action
    kind, identifier = data['kind'], data['target_id']
    stamp = now or datetime.now(timezone.utc)

    @firestore.transactional
    def commit(tx):
        membership = client.collection('staff').document(uid).get(transaction=tx)
        member = membership.to_dict() if membership.exists else None
        if not member or member.get('enabled') is not True or member.get('role') not in ('admin', 'ads_team'):
            raise CallableAccessError('permission-denied', 'Record management requires staff access.')
        ref = client.collection(COLLECTIONS[kind]).document(identifier)
        snap = ref.get(transaction=tx)
        if not snap.exists:
            raise CallableAccessError('not-found', 'Record no longer exists.')
        before = snap.to_dict()
        if not isinstance(before, dict):
            raise ValueError('Stored record needs review.')
        archived = before.get('status') == 'archived' if kind == 'draft' else before.get('archived') is True
        if kind == 'draft' and before.get('environment') != environment:
            raise CallableAccessError('permission-denied', 'Draft belongs to a different environment.')
        if operation == 'archive':
            if archived:
                raise CallableAccessError('failed-precondition', 'Record is already archived.')
            if kind == 'draft' and before.get('status') != 'draft':
                raise ValueError('Draft needs review before archiving.')
            if kind != 'draft' and before.get('enabled') is not False:
                raise CallableAccessError('failed-precondition', 'Pause the record before archiving it.')
            for collection, field in CHILDREN.get(kind, []):
                for child in _matches(client, tx, collection, field, identifier):
                    if child.to_dict().get('enabled') is True:
                        raise CallableAccessError('failed-precondition', 'Pause linked records before archiving the parent.')
        elif not archived:
            raise CallableAccessError('failed-precondition', 'Archive this record first.')
        if operation == 'delete':
            for collection, field in CHILDREN.get(kind, []):
                if _matches(client, tx, collection, field, identifier):
                    raise CallableAccessError('failed-precondition', 'Delete linked records first, starting with creatives.')
            if kind == 'draft' and _matches(client, tx, 'ad_assets', 'draft_id', identifier):
                raise CallableAccessError('failed-precondition', 'This draft owns uploaded files. Remove them first.')
            report_field = REPORTS.get(kind)
            if report_field and any(_matches(client, tx, collection, report_field, identifier)
                                    for collection in ('ad_reporting_displays', 'ad_reporting_events', 'ad_reporting_totals')):
                raise CallableAccessError('failed-precondition', 'This record has reported ad activity. Keep it archived for historical reports.')
            if kind == 'sponsor':
                if _matches(client, tx, 'staff', 'sponsor_id', identifier):
                    raise CallableAccessError('failed-precondition', 'Remove linked sponsor reporting accounts first.')
            if kind == 'creative':
                parent = client.collection('campaigns').document(before.get('campaign_id')).get(transaction=tx)
                if parent.exists and any(identifier in entry.get('creative_ids', [])
                                         for entry in parent.to_dict().get('creative_overrides', [])):
                    raise CallableAccessError('failed-precondition', 'Remove this creative from the campaign override before deleting it.')
            if kind in ('campaign', 'creative') and _matches(client, tx, 'ad_drafts', 'target_id', identifier):
                raise CallableAccessError('failed-precondition', 'Delete drafts linked to this record first.')
        if operation == 'archive':
            changes = {'status': 'archived'} if kind == 'draft' else {'archived': True}
        elif operation == 'restore':
            changes = {'status': 'draft'} if kind == 'draft' else {'archived': False}
        else:
            changes = {}
        confirmation = _digest({'operation': operation, 'kind': kind, 'actor': uid,
            'target_id': identifier, 'before': before, 'version': getattr(snap, 'update_time', None),
            'environment': environment})
        if action == 'prepare':
            return {'environment': environment, 'kind': kind, 'target_id': identifier,
                'operation': operation, 'name': before.get('name') or identifier,
                'confirmation': confirmation,
                'message': ('Deletion permanently removes this catalog record; it cannot be restored.'
                            if operation == 'delete' else 'This action does not enable ad delivery.')}
        if confirmation != data['confirmation']:
            raise CallableAccessError('aborted', 'Record changed. Refresh and review again.')
        history_id = _digest({'operation': operation, 'kind': kind, 'actor': uid, **data})
        history = client.collection(HISTORY).document(history_id)
        previous = history.get(transaction=tx)
        if previous.exists:
            raise CallableAccessError('aborted', 'Action was already submitted. Refresh the library.')
        after = None if operation == 'delete' else {**before, **changes}
        receipt = {'environment': environment, 'kind': kind, 'target_id': identifier,
            'operation': operation, 'history_id': history_id, 'changed_at': _wire(stamp)}
        if operation == 'delete':
            tx.delete(ref)
        else:
            tx.update(ref, changes)
        tx.create(history, {'environment': environment, 'kind': kind, 'action': operation,
            'target_id': identifier, 'changed_by': uid, 'changed_at': stamp,
            'before': before, 'after': after, 'receipt': receipt})
        return receipt

    return commit(client.transaction(read_only=True) if action == 'prepare' else client.transaction())
