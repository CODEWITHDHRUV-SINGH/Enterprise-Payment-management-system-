import os
import requests
from typing import Any, Dict

GOOGLE_SCRIPT_URL = os.getenv(
    'GOOGLE_SCRIPT_URL',
    'https://script.google.com/macros/s/AKfycbw4WKLk2pyHLEqLIwM8qmg5E-ZXFYWvx94Br7SVWt7YDjWPhYs7Ij9n4anMLMsoxGI3/exec'
)

async def process_payment_request(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    return await _forward_to_google_script(action, payload)

async def _forward_to_google_script(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if not GOOGLE_SCRIPT_URL:
        raise ValueError('Google Apps Script URL not configured.')

    response = requests.post(
        GOOGLE_SCRIPT_URL,
        json={'action': action, 'payload': payload},
        timeout=15,
    )
    response.raise_for_status()
    try:
        data = response.json()
    except ValueError:
        data = {'raw': response.text}
    return {'success': True, 'source': 'backend', 'data': data}
