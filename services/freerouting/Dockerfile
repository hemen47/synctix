# Freerouting is a Java application; the wrapper is Python so every native-tool service
# in this stack presents the same FastAPI shape.
FROM eclipse-temurin:21-jre-jammy

ARG FREEROUTING_VERSION=2.1.0
ENV FREEROUTING_VERSION=${FREEROUTING_VERSION}

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pinned by tag so a routing result is reproducible.
RUN curl -fsSL -o /opt/freerouting.jar \
      "https://github.com/freerouting/freerouting/releases/download/v${FREEROUTING_VERSION}/freerouting-${FREEROUTING_VERSION}.jar" \
 || echo "WARNING: freerouting jar download failed; the service will report itself unavailable"

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
COPY app/ /app/

RUN useradd -m -u 10003 router && mkdir -p /work && chown -R router:router /work
USER router

ENV FREEROUTING_PORT=3021 FREEROUTING_JAR=/opt/freerouting.jar FREEROUTING_WORK_DIR=/work
EXPOSE 3021
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${FREEROUTING_PORT}"]
