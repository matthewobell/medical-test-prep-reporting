"""Review and update sponsor identity without changing its delivery status."""
from datetime import datetime, timezone
import re

from firebase_admin import firestore
from ad_drafts import _authorize, _id, _wire
from ad_publish import HISTORY, _digest
from ad_sponsor_create import _request as validate_fields
from cloud_function_core import CallableAccessError


def edit_sponsor(client, auth, app, data, web_app_id, now=None, *, environment='test'):
    uid = _authorize(client, auth, app, web_app_id, environment=environment)
    confirming = isinstance(data, dict) and data.get('action') == 'update'
    expected = {'action', 'target_id', 'fields'} | ({'confirmation'} if confirming else set())
    if (not isinstance(data, dict) or data.get('action') not in ('prepare', 'update')
            or set(data) != expected or not _id(data.get('target_id'))
            or confirming and (not isinstance(data.get('confirmation'), str)
                or not re.fullmatch('[0-9a-f]{64}', data['confirmation']))):
        raise ValueError('Choose a sponsor and review its changes first.')
    _, fields = validate_fields({'action': 'prepare', 'request_id': '0' * 32, 'fields': data['fields']})
    stamp = now or datetime.now(timezone.utc)

    @firestore.transactional
    def commit(tx):
        membership = client.collection('staff').document(uid).get(transaction=tx)
        member = membership.to_dict() if membership.exists else None
        if not member or member.get('enabled') is not True or member.get('role') not in ('admin', 'ads_team'):
            raise CallableAccessError('permission-denied', 'Sponsor editing requires staff access.')
        ref = client.collection('sponsors').document(data['target_id'])
        snapshot = ref.get(transaction=tx)
        if not snapshot.exists:
            raise CallableAccessError('not-found', 'Sponsor no longer exists.')
        before = snapshot.to_dict()
        if not isinstance(before, dict) or type(before.get('enabled')) is not bool:
            raise ValueError('Stored sponsor needs review.')
        after = {**before, 'name': fields['name'], 'logo_url': fields['logo_url']}
        if after == before:
            raise CallableAccessError('failed-precondition', 'No sponsor details changed.')
        confirmation = _digest({'operation': 'edit_sponsor', 'actor': uid,
            'target_id': data['target_id'], 'before': before, 'after': after,
            'version': getattr(snapshot, 'update_time', None), 'environment': environment})
        if not confirming:
            return {'environment': environment, 'target_id': data['target_id'],
                'before': {'name': before['name'], 'logo_url': before['logo_url'], 'enabled': before['enabled']},
                'after': {'name': after['name'], 'logo_url': after['logo_url'], 'enabled': after['enabled']},
                'confirmation': confirmation,
                'warnings': ['Preview the logo at its destination; URL format alone does not verify the image.']}
        if data['confirmation'] != confirmation:
            raise CallableAccessError('aborted', 'Sponsor changed. Refresh and review again.')
        history_id = _digest({'operation': 'edit_sponsor', 'actor': uid, **data})
        history = client.collection(HISTORY).document(history_id)
        previous = history.get(transaction=tx)
        if previous.exists:
            raise CallableAccessError('aborted', 'This update was already submitted. Refresh the library.')
        receipt = {'environment': environment, 'target_id': data['target_id'],
            'history_id': history_id, 'updated': True, 'updated_by': uid, 'updated_at': _wire(stamp)}
        tx.update(ref, {'name': after['name'], 'logo_url': after['logo_url']})
        tx.create(history, {'environment': environment, 'kind': 'sponsor', 'action': 'edit',
            'target_id': data['target_id'], 'updated_by': uid, 'updated_at': stamp,
            'before': before, 'after': after, 'changes': [
                {'field': key, 'before': before[key], 'after': after[key]}
                for key in ('name', 'logo_url') if before[key] != after[key]], 'receipt': receipt})
        return receipt

    return commit(client.transaction(read_only=True) if not confirming else client.transaction())
