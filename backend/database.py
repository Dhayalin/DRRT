import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# Default: local SQLite -- this is literally the "offline device" database.
# Swap to Postgres for the "cloud/authority" database by setting DATABASE_URL,
# e.g.  export DATABASE_URL=postgresql+psycopg2://user:pass@host:5432/drrt
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./drrt.db")

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
