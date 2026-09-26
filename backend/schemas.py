from datetime import datetime
from typing import Optional, Dict, Any, List
from pydantic import BaseModel


class RegisterIn(BaseModel):
    username: str
    full_name: str
    password: str
    role: str  # survivor | volunteer | authority


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    username: str
    full_name: str


class ShelterOut(BaseModel):
    id: int
    code: str
    name: str
    lat: float
    lon: float
    capacity: int
    occupancy: int
    food: str
    water: str
    medicine: str
    medical_facility: str
    blankets: int
    tents: int
    fuel_liters: int
    version: int
    updated_by: str
    updated_at: datetime

    class Config:
        from_attributes = True


class ShelterUpdateIn(BaseModel):
    # client sends the version it *thinks* is current (from last fetch/queue time)
    # plus only the fields it changed, each is applied with server-side conflict
    # resolution against field_timestamps.
    base_version: int
    client_timestamp: datetime
    occupancy: Optional[int] = None
    capacity: Optional[int] = None
    food: Optional[str] = None
    water: Optional[str] = None
    medicine: Optional[str] = None
    medical_facility: Optional[str] = None
    blankets: Optional[int] = None
    tents: Optional[int] = None
    fuel_liters: Optional[int] = None


class IncidentOut(BaseModel):
    id: int
    code: str
    type: str
    description: str
    lat: Optional[float]
    lon: Optional[float]
    photo_path: Optional[str]
    verified: bool
    verified_by: Optional[str]
    reported_by: str
    reported_role: str
    created_at: datetime

    class Config:
        from_attributes = True


class SOSOut(BaseModel):
    id: int
    user: str
    lat: float
    lon: float
    status: str
    created_at: datetime

    class Config:
        from_attributes = True


class TaskOut(BaseModel):
    id: int
    label: str
    status: str
    assigned_to: Optional[str]
    shelter_code: Optional[str]

    class Config:
        from_attributes = True


class TaskCreateIn(BaseModel):
    label: str
    assigned_to: Optional[str] = None
    shelter_code: Optional[str] = None


class TaskUpdateIn(BaseModel):
    status: str


class SyncAction(BaseModel):
    client_uuid: str
    kind: str  # "shelter_update" | "incident_report" | "sos" | "verify_incident" | "task_update"
    client_timestamp: datetime
    payload: Dict[str, Any]


class SyncBatchIn(BaseModel):
    actions: List[SyncAction]


class SyncResult(BaseModel):
    client_uuid: str
    kind: str
    outcome: str  # applied | conflict_merged | rejected | duplicate_ignored
    detail: str
    server_state: Optional[Dict[str, Any]] = None


class SyncBatchOut(BaseModel):
    results: List[SyncResult]
    server_time: datetime
