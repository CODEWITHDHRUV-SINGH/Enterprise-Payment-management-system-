import os
import requests
from typing import Any, Dict
from starlette.responses import JSONResponse
from .models import PaymentRecord

GOOGLE_SCRIPT_URL = os.getenv('GOOGLE_SCRIPT_URL', '')

async def process_payment_request(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if action == 'submitPayment':
        return await _forward_to_google_script('submitPayment', payload)
    if action == 'getPayments':
        return await _forward_to_google_script('getPayments', payload)
    raise ValueError('Unsupported action: ' + action)

async def _forward_to_google_script(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if not GOOGLE_SCRIPT_URL:
        raise ValueError('Google Apps Script URL not configured.')

    response = requests.post(GOOGLE_SCRIPT_URL, json={
        'action': action,
        'payload': payload,
    }, timeout=15)
    response.raise_for_status()
    data = response.json()
    return {'success': True, 'source': 'backend', 'data': data}
