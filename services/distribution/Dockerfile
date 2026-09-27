FROM python:3.12-alpine
WORKDIR /app
COPY server.py /app/server.py
USER 65534
EXPOSE 18891
CMD ["python", "/app/server.py"]
