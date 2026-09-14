FROM python:3.12-slim

# ngspice from Debian: the version is pinned by the base image tag, and the batch-mode
# interface we use has been stable for years.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ngspice \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY app/ /app/

RUN useradd -m -u 10001 sim && mkdir -p /work && chown -R sim:sim /work
USER sim

ENV SIM_PORT=3020 SIM_WORK_DIR=/work
EXPOSE 3020
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${SIM_PORT}"]
