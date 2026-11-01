import ipaddress
import hashlib
import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlparse

import requests
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from jose import JWTError
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.config import settings
from app.core.security import create_access_token, create_signed_token, decode_signed_token
from app.models.user import User
from app.models.refresh_token import RefreshToken
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
    return RedirectResponse(url=f"{base_url}/login?token={access_token}{suffix}")


def _get_or_create_demo_user(db: Session, identity: str | None) -> tuple[User, bool]:
    raw_identity = (identity or "demo").strip().lower()
    if len(raw_identity) > 120:
        raise HTTPException(status_code=400, detail="Identity is too long")

    sanitized = re.sub(r"[^a-z0-9._-]+", ".", raw_identity).strip(".")
    if not sanitized:
        sanitized = "demo"

    email = sanitized if "@" in sanitized else f"{sanitized}@vidyaranya.local"
    display_name = sanitized.split("@")[0].replace(".", " ").replace("_", " ").strip() or "Demo User"
    demo_role = "faculty" if sanitized in {
        "faculty",
        "teacher",
        "faculty@vidyaranya.local",
        "teacher@vidyaranya.local",
    } else "student"

    user = db.query(User).filter(User.email == email).first()
    created = False
    if user is None:
        created = True
        user = User(
            email=email,
            name=" ".join(part.capitalize() for part in display_name.split()),
            role=demo_role,
            picture=None,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    elif demo_role == "faculty" and user.role != "faculty":
        user.role = "faculty"
        db.commit()
        db.refresh(user)
    return user, created


def _build_token(user: User) -> str:
    return create_access_token(
        subject=str(user.id),
        extra_claims={"role": user.role, "email": user.email},
    )


def _validate_browser_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        return
    allowed = {settings.FRONTEND_URL.rstrip("/")}
    allowed.update(item.rstrip("/") for item in settings.BACKEND_CORS_ORIGINS)
    if origin.rstrip("/") in allowed:
        return
    pattern = settings.BACKEND_CORS_ALLOW_ORIGIN_REGEX
    if pattern and re.fullmatch(pattern, origin.rstrip("/")):
        return
    raise HTTPException(status_code=403, detail="Request origin is not allowed")


def _issue_refresh_token(db: Session, user: User, response: Response) -> str:
    jti = uuid.uuid4().hex
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    token = create_signed_token(
        subject=str(user.id),
        extra_claims={"type": "refresh", "jti": jti},
        expires_minutes=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60,
    )
    db.add(RefreshToken(
        user_id=user.id,
        jti=jti,
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        expires_at=expires_at,
    ))
    db.commit()
    response.set_cookie(
        "refresh_token", token, httponly=True, secure=settings.ENVIRONMENT == "production",
        samesite="none" if settings.ENVIRONMENT == "production" else "lax",
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400, path="/auth",
    )
    return token


def _revoke_refresh_token(db: Session, raw_token: str | None) -> None:
    if not raw_token:
        return
    try:
        payload = decode_signed_token(raw_token)
    except JWTError:
        return
    jti = payload.get("jti")
    if not jti or payload.get("type") != "refresh":
        return
    record = db.query(RefreshToken).filter(RefreshToken.jti == str(jti)).first()
    if record and record.token_hash == hashlib.sha256(raw_token.encode()).hexdigest() and record.revoked_at is None:
        record.revoked_at = datetime.now(timezone.utc)
        db.commit()


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        "refresh_token", path="/auth", httponly=True,
        secure=settings.ENVIRONMENT == "production",
        samesite="none" if settings.ENVIRONMENT == "production" else "lax",
    )


@router.get("/login")
@router.get("/google/login", include_in_schema=True)
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
@router.get("/google/callback", name="google_auth_callback")
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
    redirect = _frontend_redirect(access_token, request=request, is_new_user=created)
    _issue_refresh_token(db, user, redirect)
    return redirect


@router.get("/dev-login", response_model=Token)
def dev_login(
    response: Response,
    identity: str = Query(default="demo"),
    db: Session = Depends(get_db),
) -> Token:
    if not settings.ENABLE_DEV_LOGIN:
        raise HTTPException(status_code=403, detail="Dev login is disabled")

    user, _created = _get_or_create_demo_user(db, identity)
    access_token = _build_token(user)
    if response is not None:
        _issue_refresh_token(db, user, response)
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
    redirect = _frontend_redirect(access_token, request=request, is_new_user=created)
    _issue_refresh_token(db, user, redirect)
    return redirect


@router.post("/refresh", response_model=Token)
def refresh_access_token(request: Request, response: Response, db: Session = Depends(get_db)) -> Token:
    _validate_browser_origin(request)
    raw_token = request.cookies.get("refresh_token")
    if not raw_token:
        raise HTTPException(status_code=401, detail="Refresh token is missing")
    try:
        payload = decode_signed_token(raw_token)
    except JWTError as exc:
        _clear_refresh_cookie(response)
        raise HTTPException(status_code=401, detail="Refresh token is invalid or expired") from exc
    jti = payload.get("jti")
    try:
        user_id = uuid.UUID(str(payload.get("sub")))
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=401, detail="Refresh token is invalid") from exc
    record = db.query(RefreshToken).filter(RefreshToken.jti == str(jti)).first() if jti else None
    digest = hashlib.sha256(raw_token.encode()).hexdigest()
    expires_at = record.expires_at if record else None
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if (
        payload.get("type") != "refresh" or not record or record.user_id != user_id
        or record.token_hash != digest or record.revoked_at is not None
        or not expires_at or expires_at <= datetime.now(timezone.utc)
    ):
        _clear_refresh_cookie(response)
        raise HTTPException(status_code=401, detail="Refresh token is invalid or expired")
    user = db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
    if not user:
        raise HTTPException(status_code=401, detail="Account is unavailable")
    record.revoked_at = datetime.now(timezone.utc)
    db.commit()
    access_token = _build_token(user)
    _issue_refresh_token(db, user, response)
    return Token(access_token=access_token, token_type="bearer")


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, str]:
    _validate_browser_origin(request)
    _revoke_refresh_token(db, request.cookies.get("refresh_token"))
    _clear_refresh_cookie(response)
    return {"message": "Logged out"}
