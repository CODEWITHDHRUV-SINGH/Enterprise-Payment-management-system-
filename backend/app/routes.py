from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import os
from .services import process_payment_request, set_runtime_google_script_url, get_effective_google_script_url

router = APIRouter()

class RequestPayload(BaseModel):
    action: str
    payload: dict = {}

@router.post("/api")
async def handle_request(body: RequestPayload):
    try:
        return await process_payment_request(body.action, body.payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/api/debug")
async def debug_info():
    """Return the configured Google Apps Script URL (for debugging).

    Note: don't enable this in production unless needed — it exposes the
    backend's configured external URL for debugging deployments.
    """
    return {"GOOGLE_SCRIPT_URL": get_effective_google_script_url()}


class AdminPayload(BaseModel):
    url: str


@router.post("/api/admin/set_script_url")
async def admin_set_script_url(body: AdminPayload, x_admin_token: str = None):
    """Set the Google Script URL used by the backend at runtime.

    If `ADMIN_TOKEN` env var is set, requests must include the same token in
    the `X-Admin-Token` header.
    """
    admin_token = os.getenv('ADMIN_TOKEN')
    # FastAPI will map header X-Admin-Token to the param x_admin_token automatically if provided.
    if admin_token:
        if not x_admin_token or x_admin_token != admin_token:
            raise HTTPException(status_code=403, detail='Invalid admin token')
    # Persist the override so subsequent requests use the new URL
    set_runtime_google_script_url(body.url, persist=True)
    return {"success": True, "google_script_url": get_effective_google_script_url()}
