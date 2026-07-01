import os

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.routers import auth, admin, hotels

app = FastAPI(title="HRMS - Hotel Room Management System")

# Static files & templates
static_dir = os.path.join(os.path.dirname(__file__), "static")
templates_dir = os.path.join(os.path.dirname(__file__), "templates")
uploads_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")

app.mount("/static", StaticFiles(directory=static_dir), name="static")

if os.path.exists(uploads_dir):
    app.mount("/uploads", StaticFiles(directory=uploads_dir), name="uploads")

templates = Jinja2Templates(directory=templates_dir)

# API routers
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(hotels.router)


# Page routes
@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})


@app.get("/signup", response_class=HTMLResponse)
def signup_page(request: Request):
    return templates.TemplateResponse("signup.html", {"request": request})


@app.get("/hotel-setup", response_class=HTMLResponse)
def hotel_setup_page(request: Request):
    return templates.TemplateResponse("hotel_setup.html", {"request": request})


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard_page(request: Request):
    return templates.TemplateResponse("dashboard.html", {"request": request})


@app.get("/admin", response_class=HTMLResponse)
def admin_page(request: Request):
    return templates.TemplateResponse("admin.html", {"request": request})
