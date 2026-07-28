from pydantic import BaseModel
from typing import Optional

class PaymentRecord(BaseModel):
    name: str
    phone: str
    email: Optional[str] = None
    status: Optional[str] = 'Pending'
    date: Optional[str] = None
