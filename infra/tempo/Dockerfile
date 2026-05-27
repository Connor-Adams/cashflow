FROM grafana/tempo:2.6.0
USER root
COPY config.yaml /etc/tempo.yaml
ENTRYPOINT ["/tempo"]
CMD ["-config.file=/etc/tempo.yaml"]
