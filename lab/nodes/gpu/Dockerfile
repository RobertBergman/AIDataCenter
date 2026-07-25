# A GPU compute node as the network sees it.
#
# There is no CUDA here and no GPU: what this image models is the part a network engineer
# owns -- a multi-rail host that boots with no config, gets its identity and its rail
# addressing from the seed, and then reports its NIC and (simulated) GPU telemetry back.
FROM debian:bookworm-slim

RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d \
 && apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      busybox \
      lldpd \
      iproute2 \
      iputils-ping \
      iputils-tracepath \
      curl \
      jq \
      python3 \
      ca-certificates \
      iperf3 \
      traceroute \
      tcpdump \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/sbin/policy-rc.d \
 && ln -sf /bin/busybox /usr/local/sbin/udhcpc \
 && ln -sf /bin/busybox /usr/local/sbin/tftp

COPY common/ztp-lib.sh /ztp/ztp-lib.sh
COPY common/udhcpc-handler.sh /ztp/udhcpc-handler.sh
COPY gpu/node-entrypoint.sh /ztp/node-entrypoint.sh
COPY gpu/node-exporter.py /ztp/node-exporter.py
RUN chmod +x /ztp/*.sh

EXPOSE 9200
ENTRYPOINT ["/bin/bash", "/ztp/node-entrypoint.sh"]
