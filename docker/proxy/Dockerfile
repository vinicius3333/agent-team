FROM alpine:3.20
RUN apk add --no-cache tinyproxy
EXPOSE 8888
USER 65534:65534
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
