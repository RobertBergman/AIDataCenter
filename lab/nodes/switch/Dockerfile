# A ZTP-capable NOS image.
#
# Stock sonic-vs ships no DHCP client and no LLDP daemon, so a stock image cannot
# zero-touch provision or report its cabling. Real NOS images from vendors include
# both. This layer adds them and nothing else -- the SONiC stack itself is untouched.
ARG SONIC_IMAGE=docker-sonic-vs:latest
FROM ${SONIC_IMAGE}

# Debian's lldpd postinst tries to start a service; there is no init in a build layer.
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d \
 && apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      busybox \
      lldpd \
      iputils-ping \
      iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/sbin/policy-rc.d \
 # Only udhcpc, deliberately. `busybox --install` would drop busybox applets ahead of
 # iproute2 and iputils on PATH, and busybox's cut-down `ip` cannot express most of what
 # the agent and the verification suite need.
 && ln -sf /bin/busybox /usr/local/sbin/udhcpc

# Build context is ./nodes so the ZTP library is shared with the compute node image.
COPY common/ztp-lib.sh /ztp/ztp-lib.sh
COPY common/udhcpc-handler.sh /ztp/udhcpc-handler.sh
COPY switch/switch-entrypoint.sh /ztp/switch-entrypoint.sh
RUN chmod +x /ztp/*.sh

ENTRYPOINT ["/bin/bash", "/ztp/switch-entrypoint.sh"]
