# The official image ships the browsers but not the playwright package; the run has no internet, so it is installed here.
FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /opt/qa
RUN npm init -y >/dev/null && npm install --no-audit --no-fund --omit=dev playwright@1.55.0 && chmod -R a+rX /opt/qa
