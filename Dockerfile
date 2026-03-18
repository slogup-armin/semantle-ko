FROM python:3.9-slim

ENV FLASK_APP=semantle \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . .

ENTRYPOINT [ "gunicorn", "semantle:app", "--bind", "0.0.0.0:80" ]
