from fastapi import FastAPI
from .routes import router

app = FastAPI(title="PayTrack Render Backend")
app.include_router(router)
