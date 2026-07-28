import os
import requests
from typing import Any, Dict

_DEFAULT_GOOGLE_SCRIPT_URL = os.getenv(
    'GOOGLE_SCRIPT_URL',
    'https://script.google.com/macros/s/AKfycbw4WKLk2pyHLEqLIwM8qmg5E-ZXFYWvx94Br7SVWt7YDjWPhYs7Ij9n4anMLMsoxGI3/exec'
)

# Runtime override stored in memory and optionally persisted to disk so updates
# can take effect without a full redeploy. File location is two levels up from
# this module (project root): 'gscript_override.txt'
_RUNTIME_OVERRIDE = None
_OVERRIDE_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'gscript_override.txt'))

def _load_runtime_override():
    global _RUNTIME_OVERRIDE
    try:
        if os.path.exists(_OVERRIDE_PATH):
            with open(_OVERRIDE_PATH, 'r', encoding='utf-8') as fh:
                val = fh.read().strip()
                if val:
                    _RUNTIME_OVERRIDE = val
    except Exception:
        _RUNTIME_OVERRIDE = None

def _save_runtime_override(val: str):
    global _RUNTIME_OVERRIDE
    try:
        with open(_OVERRIDE_PATH, 'w', encoding='utf-8') as fh:
            fh.write(val)
        _RUNTIME_OVERRIDE = val
    except Exception:
        _RUNTIME_OVERRIDE = val

# Initialize runtime override from disk at import
_load_runtime_override()

async def process_payment_request(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    return await _forward_to_google_script(action, payload)

async def _forward_to_google_script(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    # Resolve URL precedence: runtime override -> FORCE_GOOGLE_SCRIPT_URL env -> GOOGLE_SCRIPT_URL env/default
    force = os.getenv('FORCE_GOOGLE_SCRIPT_URL')
    google_url = _RUNTIME_OVERRIDE or force or _DEFAULT_GOOGLE_SCRIPT_URL
    if not google_url:
        raise ValueError('Google Apps Script URL not configured.')

    try:
        print(f"[services] Forwarding action='{action}' to {google_url}")
        response = requests.post(
            google_url,
            json={'action': action, 'payload': payload},
            timeout=15,
        )
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError:
            data = {'raw': response.text}
        return {
            'success': True,
            'source': 'backend',
            'google_script_url': google_url,
            'data': data,
        }
    except Exception as exc:
        print(f"[services] Error forwarding to {google_url}: {exc}")
        return {
            'success': False,
            'error': str(exc),
            'google_script_url': google_url,
        }

def set_runtime_google_script_url(url: str, persist: bool = True):
    """Set runtime override for the Google Script URL. Persist to disk if requested."""
    if persist:
        _save_runtime_override(url)
    else:
        global _RUNTIME_OVERRIDE
        _RUNTIME_OVERRIDE = url

def get_effective_google_script_url() -> str:
    """Return the currently effective Google Script URL used by the backend."""
    force = os.getenv('FORCE_GOOGLE_SCRIPT_URL')
    return _RUNTIME_OVERRIDE or force or _DEFAULT_GOOGLE_SCRIPT_URL