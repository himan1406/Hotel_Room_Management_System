import os

from fastapi import APIRouter, Request, FastAPI
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles

_app_dir = os.path.dirname(os.path.dirname(__file__))          # .../backend/app
_project_root = os.path.dirname(_app_dir)                     # .../backend

# Docker: frontend is at /app/frontend (volume mount in docker-compose)
# Local:  frontend is sibling of backend/ at the project root
_docker_frontend = os.path.join(_project_root, "frontend")
_sibling_frontend = os.path.normpath(os.path.join(_project_root, "..", "frontend"))

_frontend_dir = _docker_frontend if os.path.isdir(os.path.join(_docker_frontend, "templates")) else _sibling_frontend

templates = Jinja2Templates(directory=os.path.join(_frontend_dir, "templates"))

def mount_static_files(app: FastAPI):
    if os.path.exists(os.path.join(_frontend_dir, "static")):
        app.mount("/static", StaticFiles(directory=os.path.join(_frontend_dir, "static")), name="static")

    _uploads = os.path.join(_project_root, "uploads")
    if os.path.exists(_uploads):
        app.mount("/uploads", StaticFiles(directory=_uploads), name="uploads")

router = APIRouter()


@router.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(request, "pages/index.html")


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse(request, "pages/login.html")


@router.get("/signup", response_class=HTMLResponse)
def signup_page(request: Request):
    return templates.TemplateResponse(request, "pages/signup.html")


@router.get("/hotel-setup", response_class=HTMLResponse)
def hotel_setup_page(request: Request):
    return templates.TemplateResponse(request, "pages/hotel_setup.html")


@router.get("/dashboard", response_class=HTMLResponse)
def dashboard_page(request: Request):
    return templates.TemplateResponse(request, "dashboard/dashboard.html")


@router.get("/admin", response_class=HTMLResponse)
def admin_page(request: Request):
    return templates.TemplateResponse(request, "admin/admin.html")
