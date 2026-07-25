FROM python:3.12-slim

RUN pip install --no-cache-dir flask==3.0.3 gunicorn==22.0.0

WORKDIR /app
COPY app.py /app/app.py

# 9095, not 9090: this process shares the seed's network namespace with Prometheus,
# which owns 9090.
EXPOSE 9095
# Single worker: registration state lives in process memory (and is mirrored to disk).
CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:9095", "--access-logfile", "-", "app:app"]
