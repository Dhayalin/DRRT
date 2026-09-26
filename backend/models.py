"""
SQLAlchemy models for DRRT.

Design note on the offline/cloud DB requirement:
This app uses SQLAlchemy against a single DATABASE_URL. By default that's
SQLite (sqlite:///./drrt.db) which is exactly what the field/offline client
would use. Pointing DATABASE_URL at a Postgres DSN (e.g.
postgresql+psycopg2://user:pass@host/db) makes this the cloud/authority
database with zero code changes -- that's the whole point of using an ORM
here instead of hand-written SQLite queries. See README for both modes.
"""
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Float, Boolean, DateTime, ForeignKey, JSON, Text
)
from sqlalchemy.orm import relationship
from database import Base


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    full_name = Column(String, nullable=False)
    hashed_password = Column(String, nullable=False)
    role = Column(String, nullable=False)  # survivor | volunteer | authority
    created_at = Column(DateTime, default=datetime.utcnow)


class Shelter(Base):
    __tablename__ = "shelters"
    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, unique=True, index=True)
    name = Column(String, nullable=False)
    lat = Column(Float, nullable=False)
    lon = Column(Float, nullable=False)
    capacity = Column(Integer, default=0)
    occupancy = Column(Integer, default=0)
    food = Column(String, default="OK")       # OK | Low | Out
    water = Column(String, default="OK")      # OK | Low | Out
    medicine = Column(String, default="OK")   # OK | Low | Out
    medical_facility = Column(String, default="Available")  # Available | Unavailable
    blankets = Column(Integer, default=0)
    tents = Column(Integer, default=0)
    fuel_liters = Column(Integer, default=0)

    # ---- conflict resolution bookkeeping ----
    # monotonically increasing version, bumped on every accepted write
    version = Column(Integer, default=1)
    # per-field last-write timestamps, used to merge concurrent offline edits
    # e.g. {"occupancy": "2026-08-20T10:00:00", "food": "2026-08-20T09:50:00"}
    field_timestamps = Column(JSON, default=dict)
    updated_by = Column(String, default="system")
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Incident(Base):
    __tablename__ = "incidents"
    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, unique=True, index=True)
    type = Column(String, nullable=False)  # Flood | Fire | Road Block | ...
    description = Column(Text, default="")
    lat = Column(Float, nullable=True)
    lon = Column(Float, nullable=True)
    gps_accuracy_m = Column(Float, nullable=True)
    photo_path = Column(String, nullable=True)
    verified = Column(Boolean, default=False)
    verified_by = Column(String, nullable=True)
    reported_by = Column(String, nullable=False)
    reported_role = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    client_uuid = Column(String, unique=True, index=True, nullable=True)  # idempotency for offline replay


class SOSAlert(Base):
    __tablename__ = "sos_alerts"
    id = Column(Integer, primary_key=True, index=True)
    user = Column(String, nullable=False)
    lat = Column(Float, nullable=False)
    lon = Column(Float, nullable=False)
    gps_accuracy_m = Column(Float, nullable=True)
    status = Column(String, default="OPEN")  # OPEN | ACKNOWLEDGED | RESOLVED
    created_at = Column(DateTime, default=datetime.utcnow)
    client_uuid = Column(String, unique=True, index=True, nullable=True)


class Task(Base):
    __tablename__ = "tasks"
    id = Column(Integer, primary_key=True, index=True)
    label = Column(String, nullable=False)
    status = Column(String, default="Pending")  # Pending | In progress | Done
    assigned_to = Column(String, nullable=True)
    shelter_code = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class SyncLogEntry(Base):
    __tablename__ = "sync_log"
    id = Column(Integer, primary_key=True, index=True)
    actor = Column(String, nullable=False)
    action = Column(String, nullable=False)
    entity = Column(String, nullable=False)
    entity_id = Column(String, nullable=True)
    outcome = Column(String, nullable=False)  # applied | conflict_merged | rejected | duplicate_ignored
    detail = Column(Text, default="")
    server_time = Column(DateTime, default=datetime.utcnow)
