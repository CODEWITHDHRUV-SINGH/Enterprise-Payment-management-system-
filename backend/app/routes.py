from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from .services import process_payment_request

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
