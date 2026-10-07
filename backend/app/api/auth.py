import ipaddress
import re
from urllib.parse import urlencode, urlparse

import requests
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from jose import JWTError
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.config import settings
from app.core.security import create_access_token, create_signed_token, decode_signed_token
from app.models.user import User
from app.schemas.token import Token

router = APIRouter(prefix="/auth", tags=["auth"])


def _frontend_redirect(access_token: str, request: Request | None = None, is_new_user: bool = False) -> RedirectResponse:
    configured_base = settings.FRONTEND_URL.rstrip("/")
    base_url = configured_base
    configured_parsed = urlparse(configured_base)

    if request is not None:
        request_host = (request.url.hostname or "").strip().lower()
        allowed_hosts = {host.strip().lower() for host in settings.FRONTEND_ALLOWED_HOSTS}

        is_safe_host = False
        if request_host in allowed_hosts:
            is_safe_host = True
        else:
            try:
                parsed_ip = ipaddress.ip_address(request_host)
                is_safe_host = parsed_ip.is_private or parsed_ip.is_loopback
            except ValueError:
                is_safe_host = request_host in {"localhost", "127.0.0.1"}

        if is_safe_host and request_host:
            # Keep configured scheme/port and only trust request host for LAN/local development redirects.
            scheme = configured_parsed.scheme or request.url.scheme
            if configured_parsed.port is not None:
                host_for_netloc = request_host
                if ":" in host_for_netloc and not host_for_netloc.startswith("["):
                    host_for_netloc = f"[{host_for_netloc}]"
                netloc = f"{host_for_netloc}:{configured_parsed.port}"
            else:
                netloc = request_host
            base_url = f"{scheme}://{netloc}".rstrip("/")

    suffix = "&new=1" if is_new_user else ""
    return RedirectResponse(url=f"{base_url}/index.html?token={access_token}{suffix}")


def _get_or_create_demo_user(db: Session, identity: str | None) -> tuple[User, bool]:
    raw_identity = (identity or "demo").strip().lower()
    if len(raw_identity) > 120:
        raise HTTPException(status_code=400, detail="Identity is too long")

    sanitized = re.sub(r"[^a-z0-9._-]+", ".", raw_identity).strip(".")
    if not sanitized:
        sanitized = "demo"

    email = sanitized if "@" in sanitized else f"{sanitized}@vidyaranya.local"
    display_name = sanitized.split("@")[0].replace(".", " ").replace("_", " ").strip() or "Demo User"

    user = db.query(User).filter(User.email == email).first()
    created = False
    if user is None:
        created = True
        user = User(
            email=email,
            name=" ".join(part.capitalize() for part in display_name.split()),
            role="student",
            picture=None,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return user, created


def _build_token(user: User) -> str:
    return create_access_token(
        subject=str(user.id),
        extra_claims={"role": user.role, "email": user.email},
    )


@router.get("/login")
def login_with_google(request: Request) -> RedirectResponse:
    redirect_uri = str(request.url_for("auth_callback"))
    state_token = create_signed_token(
        subject="google_oauth",
        extra_claims={"type": "oauth_state"},
        expires_minutes=10,
    )
    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "prompt": "select_account",
        "state": state_token,
    }
    url = f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"
    return RedirectResponse(url=url)


@router.get("/callback", name="auth_callback")
def auth_callback(
    code: str,
    state: str,
    request: Request,
    db: Session = Depends(get_db),
) -> RedirectResponse:
    try:
        state_payload = decode_signed_token(state)
        if state_payload.get("type") != "oauth_state" or state_payload.get("sub") != "google_oauth":
            raise HTTPException(status_code=400, detail="Invalid OAuth state")
    except JWTError as exc:
        raise HTTPException(status_code=400, detail="Invalid OAuth state") from exc

    redirect_uri = str(request.url_for("auth_callback"))

    token_response = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": settings.GOOGLE_CLIENT_ID,
            "client_secret": settings.GOOGLE_CLIENT_SECRET,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    if token_response.status_code >= 400:
        raise HTTPException(status_code=400, detail="Failed to exchange Google auth code")

    google_access_token = token_response.json().get("access_token")
    if not google_access_token:
        raise HTTPException(status_code=400, detail="Missing Google access token")

    userinfo_response = requests.get(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        headers={"Authorization": f"Bearer {google_access_token}"},
        timeout=30,
    )
    if userinfo_response.status_code >= 400:
        raise HTTPException(status_code=400, detail="Failed to fetch Google user profile")

    user_info = userinfo_response.json()
    email = user_info.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="Google account did not return an email")

    user = db.query(User).filter(User.email == email).first()
    created = False
    if user is None:
        created = True
        user = User(
            email=email,
            name=user_info.get("name") or email,
            picture=user_info.get("picture"),
            role="student",
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    access_token = _build_token(user)
    return _frontend_redirect(access_token, request=request, is_new_user=created)


@router.get("/dev-login", response_model=Token)
def dev_login(
    identity: str = Query(default="demo"),
    db: Session = Depends(get_db),
) -> Token:
    if not settings.ENABLE_DEV_LOGIN:
        raise HTTPException(status_code=403, detail="Dev login is disabled")

    user, _created = _get_or_create_demo_user(db, identity)
    access_token = _build_token(user)
    return Token(access_token=access_token, token_type="bearer")


@router.get("/dev-login-redirect")
def dev_login_redirect(
    request: Request,
    identity: str = Query(default="demo"),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    if not settings.ENABLE_DEV_LOGIN:
        raise HTTPException(status_code=403, detail="Dev login is disabled")

    user, created = _get_or_create_demo_user(db, identity)
    access_token = _build_token(user)
    return _frontend_redirect(access_token, request=request, is_new_user=created)
