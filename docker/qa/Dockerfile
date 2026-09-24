# The official image ships the browsers but not the playwright package; the run has no internet, so it is installed here.
FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /opt/qa
RUN npm init -y >/dev/null && npm install --no-audit --no-fund --omit=dev playwright@1.55.0 && chmod -R a+rX /opt/qa
# The scripts live in the image rather than being mounted from the install directory, so agent-team
# can itself run in a container: the Docker daemon resolves bind mounts against the host, not this container.
COPY screenshot.mjs render-icons.mjs render-marketing.mjs /opt/qa/
