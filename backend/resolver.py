"""
Field-level last-write-wins conflict resolution.

Two volunteers can edit the same shelter offline at the same time (e.g. one
updates food stock, another updates occupancy -- or worse, both touch the
same field). We resolve this per-field rather than per-record:

  - Every shelter carries `field_timestamps`: {field_name: iso_timestamp}
    recording when each field was last *client-authored* (not when it hit
    the server).
  - When an update for field X arrives with client_timestamp T:
      * if no stored timestamp for X, or T is newer -> apply, store T
      * if T is older than the stored timestamp -> reject that field only
        (someone else's later edit already won), the rest of the payload
        still applies normally.
  - `version` is a simple monotonic counter bumped whenever at least one
    field is actually applied; it's surfaced to clients mainly so the UI
    can show "this record has changed since you loaded it".

This means concurrent edits to *different* fields on the same shelter both
survive (no data loss), and concurrent edits to the *same* field resolve
deterministically by which edit actually happened later in the real world,
not by which one happened to sync first.
"""
from datetime import datetime
from typing import Optional
import models


UPDATABLE_FIELDS = [
    "occupancy", "capacity", "food", "water", "medicine",
    "medical_facility", "blankets", "tents", "fuel_liters",
]


def apply_shelter_update(shelter: models.Shelter, fields: dict, client_timestamp: datetime,
                          base_version: Optional[int], actor: str):
    """Mutates `shelter` in place. Returns (outcome, detail_str)."""
    field_timestamps = dict(shelter.field_timestamps or {})
    applied = []
    rejected = []

    for field, value in fields.items():
        if value is None or field not in UPDATABLE_FIELDS:
            continue
        stored_ts_raw = field_timestamps.get(field)
        stored_ts = datetime.fromisoformat(stored_ts_raw) if stored_ts_raw else None
        if stored_ts is None or client_timestamp >= stored_ts:
            setattr(shelter, field, value)
            field_timestamps[field] = client_timestamp.isoformat()
            applied.append(field)
        else:
            rejected.append(field)

    concurrent_edit_detected = base_version is not None and base_version != shelter.version

    if applied:
        shelter.field_timestamps = field_timestamps
        shelter.version = (shelter.version or 1) + 1
        shelter.updated_by = actor
        shelter.updated_at = datetime.utcnow()

    if rejected:
        outcome = "conflict_merged"
        detail = (
            f"Applied {applied or 'no'} field(s); rejected stale edit(s) to "
            f"{rejected} because a newer update for that field already landed."
        )
    elif concurrent_edit_detected:
        outcome = "conflict_merged"
        detail = (
            f"Record changed since client's base_version={base_version} "
            f"(now v{shelter.version}), but no field-level collisions -- "
            f"all {applied} field(s) merged cleanly."
        )
    elif applied:
        outcome = "applied"
        detail = f"Applied field(s): {applied}"
    else:
        outcome = "duplicate_ignored"
        detail = "No updatable fields present in payload."

    return outcome, detail
