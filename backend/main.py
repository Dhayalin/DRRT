import os
import shutil
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

import models
import schemas
from database import Base, engine, get_db
from auth import (
    verify_password, hash_password, create_access_token,
    get_current_user, require_roles,
)
from resolver import apply_shelter_update

Base.metadata.create_all(bind=engine)



app = FastAPI(title="DRRT API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



def log_sync(db: Session, actor: str, action: str, entity: str, entity_id, outcome: str, detail: str = ""):
    db.add(models.SyncLogEntry(
        actor=actor, action=action, entity=entity, entity_id=str(entity_id),
        outcome=outcome, detail=detail,
    ))


# ---------------------------------------------------------------- seed data
def seed(db: Session):
    if db.query(models.User).count() > 0:
        return
    demo_users = [
        ("survivor1", "Ariya Survivor", "password123", "survivor"),
        ("vol1", "Karthik Volunteer", "password123", "volunteer"),
        ("authority1", "Dr. Meera (Authority)", "password123", "authority"),
    ]
    for username, name, pw, role in demo_users:
        db.add(models.User(username=username, full_name=name, hashed_password=hash_password(pw), role=role))

    shelters = [
        ("SH-01", "Govt. Higher Sec. School", 13.0827, 80.2707, 220, 168, "OK", "OK", "OK", "Available"),
        ("SH-02", "Community Hall — Sector 9", 13.0900, 80.2200, 120, 120, "Low", "OK", "Low", "Unavailable"),
        ("SH-03", "St. Xavier Parish Hall", 13.0500, 80.2500, 150, 64, "OK", "Low", "OK", "Available"),
        ("SH-04", "Riverside School", 13.1000, 80.3000, 180, 180, "Out", "Low", "Out", "Unavailable"),
        ("SH-05", "Town Sports Complex", 13.0600, 80.2800, 300, 97, "OK", "OK", "OK", "Available"),
        ("SH-06", "Textile Mill Warehouse", 13.0400, 80.2100, 90, 31, "OK", "OK", "Low", "Unavailable"),
    ]
    for code, name, lat, lon, cap, occ, food, water, med, medf in shelters:
        db.add(models.Shelter(
            code=code, name=name, lat=lat, lon=lon, capacity=cap, occupancy=occ,
            food=food, water=water, medicine=med, medical_facility=medf,
            blankets=40, tents=10, fuel_liters=200,
            version=1, field_timestamps={}, updated_by="seed",
        ))

    incidents = [
        ("INC-011", "Building Collapse", "Partial roof collapse, Textile Mill east wing", 13.041, 80.211, True),
        ("INC-012", "Injured Person", "Elderly resident needs medical evac, near SH-04", 13.099, 80.298, True),
        ("INC-013", "Road Block", "Fallen tree blocking access to Sector 9", 13.091, 80.222, False),
        ("INC-014", "Flood", "Water level rising near NH-48 underpass", 13.083, 80.271, False),
    ]
    for code, typ, desc, lat, lon, verified in incidents:
        db.add(models.Incident(
            code=code, type=typ, description=desc, lat=lat, lon=lon,
            verified=verified, verified_by="authority1" if verified else None,
            reported_by="survivor1", reported_role="survivor",
        ))

    tasks = [
        ("Deliver water containers to SH-04", "Pending", "vol1", "SH-04"),
        ("Verify road block report near Sector 9", "In progress", "vol1", "SH-02"),
        ("Escort medical team to SH-02", "Pending", None, "SH-02"),
    ]
    for label, status_, assignee, code in tasks:
        db.add(models.Task(label=label, status=status_, assigned_to=assignee, shelter_code=code))

    db.commit()


from database import SessionLocal
_db = SessionLocal()
seed(_db)
_db.close()


# ---------------------------------------------------------------- auth
@app.post("/auth/register", response_model=schemas.TokenOut)
def register(body: schemas.RegisterIn, db: Session = Depends(get_db)):
    if body.role not in ("survivor", "volunteer", "authority"):
        raise HTTPException(400, "role must be survivor, volunteer, or authority")
    if db.query(models.User).filter(models.User.username == body.username).first():
        raise HTTPException(400, "username already taken")
    user = models.User(
        username=body.username, full_name=body.full_name,
        hashed_password=hash_password(body.password), role=body.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_access_token({"sub": user.username, "role": user.role})
    return schemas.TokenOut(access_token=token, role=user.role, username=user.username, full_name=user.full_name)


@app.post("/auth/login", response_model=schemas.TokenOut)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.username == form.username).first()
    if not user or not verify_password(form.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect username or password")
    token = create_access_token({"sub": user.username, "role": user.role})
    return schemas.TokenOut(access_token=token, role=user.role, username=user.username, full_name=user.full_name)


# ---------------------------------------------------------------- shelters
@app.get("/shelters", response_model=List[schemas.ShelterOut])
def list_shelters(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return db.query(models.Shelter).all()


@app.patch("/shelters/{code}", response_model=schemas.ShelterOut)
def update_shelter(code: str, body: schemas.ShelterUpdateIn, db: Session = Depends(get_db),
                    user: models.User = Depends(require_roles("volunteer", "authority"))):
    shelter = db.query(models.Shelter).filter(models.Shelter.code == code).first()
    if not shelter:
        raise HTTPException(404, "shelter not found")
    fields = body.dict(exclude={"base_version", "client_timestamp"}, exclude_none=True)
    outcome, detail = apply_shelter_update(shelter, fields, body.client_timestamp, body.base_version, user.username)
    log_sync(db, user.username, "shelter_update", "shelter", code, outcome, detail)
    db.commit()
    db.refresh(shelter)
    return shelter


# ---------------------------------------------------------------- incidents
@app.get("/incidents", response_model=List[schemas.IncidentOut])
def list_incidents(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return db.query(models.Incident).order_by(models.Incident.created_at.desc()).all()


@app.get("/incidents/heatmap")
def incidents_heatmap(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Returns [lat, lon, weight] points for a leaflet.heat-style heatmap.
    Unverified reports are weighted lower than verified ones."""
    rows = db.query(models.Incident).filter(
        models.Incident.lat.isnot(None), models.Incident.lon.isnot(None)
    ).all()
    return [[r.lat, r.lon, 1.0 if r.verified else 0.5] for r in rows]


@app.post("/incidents", response_model=schemas.IncidentOut)
async def report_incident(
    type: str = Form(...),
    description: str = Form(""),
    lat: Optional[float] = Form(None),
    lon: Optional[float] = Form(None),
    gps_accuracy_m: Optional[float] = Form(None),
    client_uuid: Optional[str] = Form(None),
    photo: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    if client_uuid:
        existing = db.query(models.Incident).filter(models.Incident.client_uuid == client_uuid).first()
        if existing:
            return existing  # idempotent replay from offline queue

    photo_path = None
    if photo is not None and photo.filename:
        from vercel.blob import AsyncBlobClient
        ext = os.path.splitext(photo.filename)[1] or ".jpg"
        fname = f"{uuid.uuid4().hex}{ext}"
        blob_client = AsyncBlobClient()
        blob = await blob_client.put(f"incidents/{fname}", await photo.read(), access="public")
        photo_path = blob.url

    code = f"INC-{uuid.uuid4().hex[:6].upper()}"
    inc = models.Incident(
        code=code, type=type, description=description, lat=lat, lon=lon,
        gps_accuracy_m=gps_accuracy_m, photo_path=photo_path, verified=False,
        reported_by=user.username, reported_role=user.role, client_uuid=client_uuid,
    )
    db.add(inc)
    log_sync(db, user.username, "incident_report", "incident", code, "applied", type)
    db.commit()
    db.refresh(inc)
    return inc


@app.post("/incidents/{code}/verify", response_model=schemas.IncidentOut)
def verify_incident(code: str, db: Session = Depends(get_db),
                     user: models.User = Depends(require_roles("volunteer", "authority"))):
    inc = db.query(models.Incident).filter(models.Incident.code == code).first()
    if not inc:
        raise HTTPException(404, "incident not found")
    inc.verified = True
    inc.verified_by = user.username
    log_sync(db, user.username, "verify_incident", "incident", code, "applied")
    db.commit()
    db.refresh(inc)
    return inc


# ---------------------------------------------------------------- SOS
@app.post("/sos", response_model=schemas.SOSOut)
def send_sos(
    lat: float = Form(...),
    lon: float = Form(...),
    gps_accuracy_m: Optional[float] = Form(None),
    client_uuid: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    if client_uuid:
        existing = db.query(models.SOSAlert).filter(models.SOSAlert.client_uuid == client_uuid).first()
        if existing:
            return existing
    alert = models.SOSAlert(user=user.username, lat=lat, lon=lon, gps_accuracy_m=gps_accuracy_m,
                             client_uuid=client_uuid)
    db.add(alert)
    log_sync(db, user.username, "sos", "sos", None, "applied", f"({lat:.4f},{lon:.4f})")
    db.commit()
    db.refresh(alert)
    return alert


@app.get("/sos", response_model=List[schemas.SOSOut])
def list_sos(db: Session = Depends(get_db), user: models.User = Depends(require_roles("volunteer", "authority"))):
    return db.query(models.SOSAlert).order_by(models.SOSAlert.created_at.desc()).all()


# ---------------------------------------------------------------- tasks
@app.get("/tasks", response_model=List[schemas.TaskOut])
def list_tasks(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    return db.query(models.Task).all()


@app.post("/tasks", response_model=schemas.TaskOut)
def create_task(body: schemas.TaskCreateIn, db: Session = Depends(get_db),
                 user: models.User = Depends(require_roles("authority"))):
    task = models.Task(label=body.label, assigned_to=body.assigned_to, shelter_code=body.shelter_code)
    db.add(task)
    log_sync(db, user.username, "task_create", "task", None, "applied", body.label)
    db.commit()
    db.refresh(task)
    return task


@app.patch("/tasks/{task_id}", response_model=schemas.TaskOut)
def update_task(task_id: int, body: schemas.TaskUpdateIn, db: Session = Depends(get_db),
                 user: models.User = Depends(require_roles("volunteer", "authority"))):
    task = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not task:
        raise HTTPException(404, "task not found")
    task.status = body.status
    log_sync(db, user.username, "task_update", "task", task_id, "applied", body.status)
    db.commit()
    db.refresh(task)
    return task


# ---------------------------------------------------------------- dashboard
@app.get("/dashboard/summary")
def dashboard_summary(db: Session = Depends(get_db),
                       user: models.User = Depends(require_roles("authority"))):
    shelters = db.query(models.Shelter).all()
    total_cap = sum(s.capacity for s in shelters)
    total_occ = sum(s.occupancy for s in shelters)
    open_incidents = db.query(models.Incident).filter(models.Incident.verified == False).count()  # noqa: E712
    verified_incidents = db.query(models.Incident).filter(models.Incident.verified == True).count()  # noqa: E712
    open_sos = db.query(models.SOSAlert).filter(models.SOSAlert.status == "OPEN").count()
    volunteers = db.query(models.User).filter(models.User.role == "volunteer").count()
    return {
        "active_shelters": len(shelters),
        "beds_available": max(total_cap - total_occ, 0),
        "avg_occupancy_pct": round((total_occ / total_cap) * 100) if total_cap else 0,
        "open_incidents": open_incidents,
        "verified_incidents": verified_incidents,
        "open_sos": open_sos,
        "volunteers_registered": volunteers,
    }


@app.get("/sync/log")
def sync_log(limit: int = 30, db: Session = Depends(get_db),
             user: models.User = Depends(require_roles("authority"))):
    rows = db.query(models.SyncLogEntry).order_by(models.SyncLogEntry.server_time.desc()).limit(limit).all()
    return [
        {"actor": r.actor, "action": r.action, "entity": r.entity, "entity_id": r.entity_id,
         "outcome": r.outcome, "detail": r.detail, "server_time": r.server_time.isoformat()}
        for r in rows
    ]


# ---------------------------------------------------------------- batch sync
@app.post("/sync/batch", response_model=schemas.SyncBatchOut)
def sync_batch(body: schemas.SyncBatchIn, db: Session = Depends(get_db),
                user: models.User = Depends(get_current_user)):
    """
    Endpoint the mobile/web client's offline queue replays against once
    connectivity returns. Each action is processed independently, in order,
    and each result is reported back so the client can show exactly what
    happened (applied / merged-with-conflict / rejected / already-synced).
    """
    results = []
    for action in body.actions:
        try:
            if action.kind == "shelter_update":
                if user.role not in ("volunteer", "authority"):
                    results.append(schemas.SyncResult(client_uuid=action.client_uuid, kind=action.kind,
                                                        outcome="rejected", detail="role not permitted"))
                    continue
                code = action.payload.get("code")
                shelter = db.query(models.Shelter).filter(models.Shelter.code == code).first()
                if not shelter:
                    results.append(schemas.SyncResult(client_uuid=action.client_uuid, kind=action.kind,
                                                        outcome="rejected", detail=f"shelter {code} not found"))
                    continue
                fields = {k: v for k, v in action.payload.items() if k not in ("code", "base_version")}
                outcome, detail = apply_shelter_update(
                    shelter, fields, action.client_timestamp, action.payload.get("base_version"), user.username
                )
                log_sync(db, user.username, "shelter_update", "shelter", code, outcome, detail)
                db.commit()
                db.refresh(shelter)
                results.append(schemas.SyncResult(
                    client_uuid=action.client_uuid, kind=action.kind, outcome=outcome, detail=detail,
                    server_state=schemas.ShelterOut.model_validate(shelter).model_dump(mode="json"),
                ))

            elif action.kind == "incident_report":
                existing = db.query(models.Incident).filter(
                    models.Incident.client_uuid == action.client_uuid
                ).first()
                if existing:
                    results.append(schemas.SyncResult(client_uuid=action.client_uuid, kind=action.kind,
                                                        outcome="duplicate_ignored",
                                                        detail="already synced earlier"))
                    continue
                p = action.payload
                code = f"INC-{uuid.uuid4().hex[:6].upper()}"
                inc = models.Incident(
                    code=code, type=p.get("type", "Other"), description=p.get("description", ""),
                    lat=p.get("lat"), lon=p.get("lon"), verified=False,
                    reported_by=user.username, reported_role=user.role, client_uuid=action.client_uuid,
                )
                db.add(inc)
                log_sync(db, user.username, "incident_report", "incident", code, "applied")
                db.commit()
                results.append(schemas.SyncResult(client_uuid=action.client_uuid, kind=action.kind,
                                                    outcome="applied", detail=f"created {code}"))

            elif action.kind == "sos":
                existing = db.query(models.SOSAlert).filter(
                    models.SOSAlert.client_uuid == action.client_uuid
                ).first()
                if existing:
                    results.append(schemas.SyncResult(client_uuid=action.client_uuid, kind=action.kind,
                                                        outcome="duplicate_ignored", detail="already synced"))
                    continue
                p = action.payload
                alert = models.SOSAlert(user=user.username, lat=p["lat"], lon=p["lon"],
                                         gps_accuracy_m=p.get("gps_accuracy_m"), client_uuid=action.client_uuid)
                db.add(alert)
                log_sync(db, user.username, "sos", "sos", None, "applied")
                db.commit()
                results.append(schemas.SyncResult(client_uuid=action.client_uuid, kind=action.kind,
                                                    outcome="applied", detail="SOS recorded"))

            elif action.kind == "verify_incident":
                code = action.payload.get("code")
                inc = db.query(models.Incident).filter(models.Incident.code == code).first()
                if not inc:
                    results.append(schemas.SyncResult(client_uuid=action.client_uuid, kind=action.kind,
                                                        outcome="rejected", detail="incident not found"))
                    continue
                inc.verified = True
                inc.verified_by = user.username
                log_sync(db, user.username, "verify_incident", "incident", code, "applied")
                db.commit()
                results.append(schemas.SyncResult(client_uuid=action.client_uuid, kind=action.kind,
                                                    outcome="applied", detail=f"verified {code}"))
            else:
                results.append(schemas.SyncResult(client_uuid=action.client_uuid, kind=action.kind,
                                                    outcome="rejected", detail="unknown action kind"))
        except Exception as e:  # keep batch resilient: one bad action shouldn't sink the rest
            db.rollback()
            results.append(schemas.SyncResult(client_uuid=action.client_uuid, kind=action.kind,
                                                outcome="rejected", detail=str(e)))

    return schemas.SyncBatchOut(results=results, server_time=datetime.utcnow())


@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}
