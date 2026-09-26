# Road API — MKAD road routing (see server.py header). Stdlib only.
FROM python:3.12-alpine
WORKDIR /srv/demo
COPY server.py traffic.py index.html v2.html ./
RUN mkdir -p cache
ENV DEMO_PORT=8123 HOST=0.0.0.0
# The ring polygon lives one level up (ROOT/data), read-only.
VOLUME ["/srv/data"]
EXPOSE 8123
CMD ["python3", "server.py"]
