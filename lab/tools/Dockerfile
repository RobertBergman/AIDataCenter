# Toolchain image: renders every generated artifact in the lab.
#
# Containerised so the pipeline needs nothing on the host but Docker, and so the render
# is reproducible rather than dependent on whatever Python happens to be installed.
FROM python:3.12-slim

RUN pip install --no-cache-dir \
      pyyaml==6.0.2 \
      jinja2==3.1.4 \
      pynetbox==7.4.0 \
      requests==2.32.3

WORKDIR /lab/tools
ENV PYTHONUNBUFFERED=1
ENV SOT_DIR=/lab/sot

CMD ["python", "--version"]
