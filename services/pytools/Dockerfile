FROM python:3.12-slim

# SKiDL and PySpice both shell out to native tooling; kiutils is pure Python.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ngspice-shared libngspice0 git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY app/ /app/

RUN useradd -m -u 10002 pytools
USER pytools

ENV PYTOOLS_PORT=3022
EXPOSE 3022
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PYTOOLS_PORT}"]
