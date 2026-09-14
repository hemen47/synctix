# The KiCad version is pinned by this tag, so "which KiCad produced this Gerber" is
# answerable from the image alone.
FROM kicad/kicad:9.0

USER root

# kicad/kicad ships Python, but not the web stack; install it system-wide and allow it
# to coexist with the distro packages KiCad itself relies on.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
COPY app/ /app/

RUN mkdir -p /work && chown -R kicad:kicad /work /app
USER kicad

ENV KICAD_PORT=3019 KICAD_WORK_DIR=/work
EXPOSE 3019

# kicad-cli needs a writable HOME for its config, or every invocation warns.
ENV HOME=/tmp

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${KICAD_PORT}"]
