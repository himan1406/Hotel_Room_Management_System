import os

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

_app_dir = os.path.dirname(os.path.dirname(__file__))          # /app/app
_container_root = os.path.dirname(_app_dir)                     # /app
_frontend_dir = os.path.join(_container_root, "frontend")

templates = Jinja2Templates(directory=os.path.join(_frontend_dir, "templates"))

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
