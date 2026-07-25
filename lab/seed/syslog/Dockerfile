FROM python:3.12-slim
COPY collector.py /app/collector.py
WORKDIR /app
EXPOSE 514/udp 9101
CMD ["python", "-u", "collector.py"]
