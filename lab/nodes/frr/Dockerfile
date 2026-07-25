# A ZTP-capable switch built on FRR + the Linux data plane.
#
# The counterpart to the sonic-vs image. That one gives real NOS semantics (CONFIG_DB,
# SAI, syncd) but no packet forwarding; this one gives real forwarding -- the kernel
# bridges and routes for real, at line rate, with real ECMP hashing -- but is a plain
# Linux router rather than a NOS.
#
# Both are provisioned by the same seed, from the same source of truth, over the same
# zero-touch flow. Only the personality of the switch differs.
FROM frrouting/frr:latest

# The base image already ships bash, udhcpc (busybox), iproute2 and ping.
RUN apk add --no-cache \
      lldpd \
      curl \
      jq \
      iperf3 \
      tcpdump \
      bridge-utils

COPY common/ztp-lib.sh /ztp/ztp-lib.sh
COPY common/udhcpc-handler.sh /ztp/udhcpc-handler.sh
COPY frr/frr-entrypoint.sh /ztp/frr-entrypoint.sh
RUN chmod +x /ztp/*.sh

ENTRYPOINT ["/bin/bash", "/ztp/frr-entrypoint.sh"]
