# SPDX-License-Identifier: Apache-2.0
FROM ghcr.io/project-osrm/osrm-backend:latest

# The engine supervises osrm-routed children itself (graphs.py), so the image
# needs python3 next to the OSRM binaries. Graphs are mounted read-only from
# the graphs/ volume; /graph-pages is the tmpfs the supervisor pages graphs
# into before launch (mmap over bind mounts is latency-bound on Mac Docker).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY graphs.py server.py traffic.py metro.py metro_timetable.py ./

ENV ENGINE3_PORT=8124 \
    ENGINE3_GRAPHS_DIR=/srv/graphs \
    ENGINE3_PAGE_DIR=/graph-pages \
    ENGINE3_OSRM_BASE_PORT=5300
EXPOSE 8124

CMD ["python3", "server.py"]
