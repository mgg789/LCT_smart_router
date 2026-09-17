FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY core/requirements.txt /tmp/router-requirements.txt
RUN python -m pip install --no-cache-dir -r /tmp/router-requirements.txt \
    && useradd --create-home --uid 10001 router \
    && mkdir -p /app/state \
    && chown -R router:router /app/state

COPY core /app/core

USER router
EXPOSE 8100

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=2)"

ENTRYPOINT ["python", "-m", "core"]
