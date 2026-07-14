# DHub Deployment Guide

## Overview

DHub is an enterprise-grade document processing and vector synchronization platform. This guide covers deployment strategies for development, staging, and production environments.

## Prerequisites

### Required Software
- **Docker** 20.10+ and **Docker Compose** 2.0+
- **Node.js** 20 LTS (for local development)
- **MongoDB** 7.0+ (or use Docker Compose)
- **Redis** 7.0+ (or use Docker Compose)
- **Git** 2.0+

### Required Accounts
- Google OAuth credentials (Google Cloud Console)
- GitHub OAuth credentials (GitHub Settings)
- Gemini API key (Google AI Studio)
- Optional: AWS account for S3 storage
- Optional: Sentry account for error tracking

## Local Development Setup

### 1. Clone and Install

```bash
git clone <repository-url>
cd DHub
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env.local
```

Edit `.env.local` with local values:
```env
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/dhub
REDIS_HOST=localhost
GEMINI_API_KEY=your_api_key
```

### 3. Start Services

Using Docker Compose:
```bash
docker-compose up -d mongo redis
```

Or install MongoDB/Redis locally.

### 4. Run Application

```bash
npm run dev
```

Access at `http://localhost:3000`

## Docker Deployment

### Quick Start

```bash
# Copy environment template
cp .env.example .env

# Edit with production values
nano .env

# Start all services
docker-compose up -d
```

### Check Status

```bash
# View running containers
docker-compose ps

# Check logs
docker-compose logs -f app

# Health check
curl http://localhost:3000/health
```

### Stop Services

```bash
docker-compose down

# Remove volumes (be careful!)
docker-compose down -v
```

## Production Deployment

### AWS ECS (Recommended for AWS Users)

#### Prerequisites
- AWS account with ECR and ECS access
- AWS CLI v2

#### Steps

1. **Create ECR Repository**
```bash
aws ecr create-repository \
  --repository-name dhub \
  --region us-east-1
```

2. **Build and Push Image**
```bash
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

docker build -t dhub:latest .

docker tag dhub:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/dhub:latest

docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/dhub:latest
```

3. **Create ECS Task Definition** (via AWS Console or CLI)
```json
{
  "family": "dhub",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "containerDefinitions": [{
    "name": "app",
    "image": "<account-id>.dkr.ecr.us-east-1.amazonaws.com/dhub:latest",
    "portMappings": [{"containerPort": 3000}],
    "environment": [
      {"name": "NODE_ENV", "value": "production"},
      {"name": "MONGODB_URI", "value": "..."}
    ],
    "secrets": [
      {"name": "JWT_SECRET", "valueFrom": "arn:aws:secretsmanager:..."}
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/dhub",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "ecs"
      }
    }
  }]
}
```

4. **Create ECS Service**
```bash
aws ecs create-service \
  --cluster production \
  --service-name dhub \
  --task-definition dhub:1 \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}"
```

### Google Cloud Run

```bash
# Authenticate
gcloud auth login

# Create project
gcloud projects create dhub-prod

# Set project
gcloud config set project dhub-prod

# Build and deploy
gcloud run deploy dhub \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "MONGODB_URI=<connection-string>,REDIS_HOST=<host>"
```

### Kubernetes (Enterprise)

1. **Build Docker image and push to registry**
2. **Create Kubernetes manifests**

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dhub
spec:
  replicas: 3
  selector:
    matchLabels:
      app: dhub
  template:
    metadata:
      labels:
        app: dhub
    spec:
      containers:
      - name: app
        image: registry.example.com/dhub:v1.0.0
        ports:
        - containerPort: 3000
        env:
        - name: MONGODB_URI
          valueFrom:
            secretKeyRef:
              name: dhub-secrets
              key: mongodb-uri
        - name: REDIS_HOST
          value: redis-service
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: dhub-service
spec:
  type: LoadBalancer
  ports:
  - port: 80
    targetPort: 3000
  selector:
    app: dhub
```

3. **Deploy to Kubernetes**
```bash
kubectl apply -f k8s/
kubectl get pods
kubectl logs -f deployment/dhub
```

## Database Setup

### MongoDB Atlas (Cloud)

1. Create cluster at mongodb.com
2. Get connection string: `mongodb+srv://user:pass@cluster.mongodb.net/dhub`
3. Set in `MONGODB_URI`

### Local MongoDB

```bash
# Using Docker Compose (already configured)
docker-compose up -d mongo

# Or install locally and run
mongod --dbpath /data/db
```

### Initial Data Setup

```bash
# Connect to MongoDB
mongosh mongodb://localhost:27017

# Create database
use dhub

# Create indexes
db.documents.createIndex({ "connector": 1 })
db.documents.createIndex({ "createdAt": -1 })
db.documents.createIndex({ "status": 1 })
db.connectors.createIndex({ "type": 1 })
```

## Redis Setup

### Using Docker Compose

Already configured in docker-compose.yml

### Local Redis

```bash
# Install
brew install redis  # macOS
# or
apt-get install redis-server  # Linux

# Run
redis-server --port 6379
```

## Environment Configuration

### Critical Variables (Must be set)

```env
# Security
JWT_SECRET=<at-least-32-random-characters>
REFRESH_TOKEN_SECRET=<at-least-32-random-characters>

# Database
MONGODB_URI=<connection-string>

# APIs
GEMINI_API_KEY=<your-gemini-key>

# OAuth (for enabled connectors)
GOOGLE_OAUTH_CLIENT_ID=<client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<client-secret>
GITHUB_OAUTH_CLIENT_ID=<client-id>
GITHUB_OAUTH_CLIENT_SECRET=<client-secret>
```

### Optional Variables

```env
# AWS S3
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
AWS_S3_BUCKET=<bucket-name>

# Error Tracking
SENTRY_DSN=<sentry-dsn>

# Feature Flags
ENABLE_BATCH_OPERATIONS=true
ENABLE_CONNECTOR_SYNC=true
```

## Monitoring & Logging

### Docker Logs

```bash
# View logs
docker-compose logs app

# Follow logs in real-time
docker-compose logs -f app

# Filter by error
docker-compose logs app | grep ERROR
```

### Application Health

```bash
# Check health endpoint
curl http://localhost:3000/health

# Monitor uptime
curl -i http://localhost:3000/health
```

### Resource Monitoring

```bash
# Docker stats
docker stats

# Memory usage
docker-compose exec app ps aux
```

## Scaling Considerations

### Horizontal Scaling
- Use load balancer (AWS ELB, Google Cloud LB, NGINX)
- Multiple containers behind the same MongoDB/Redis
- Session storage in Redis (already configured)

### Vertical Scaling
- Increase container CPU/memory limits
- Optimize Node.js heap size: `NODE_OPTIONS=--max-old-space-size=2048`
- Tune database connection pools

## Security Checklist

- [ ] Change all default passwords
- [ ] Enable HTTPS/TLS (use reverse proxy like NGINX)
- [ ] Set strong JWT secrets (min 32 chars random)
- [ ] Enable MongoDB authentication
- [ ] Restrict Redis to internal network only
- [ ] Use environment variables for secrets (never commit .env)
- [ ] Enable CORS restrictions to known domains
- [ ] Set up rate limiting per user
- [ ] Enable API authentication middleware
- [ ] Regular security updates: `npm audit`, Docker image updates

## Backup & Recovery

### MongoDB Backup

```bash
# Backup
mongodump --uri="mongodb://localhost:27017" --out /backups/mongo

# Restore
mongorestore --uri="mongodb://localhost:27017" /backups/mongo
```

### Automated Backups

Add to crontab:
```bash
0 2 * * * mongodump --uri="mongodb://prod:pass@host/dhub" --out /backups/mongo-$(date +%Y%m%d)
```

## Troubleshooting

### Services won't start

```bash
# Check Docker daemon
docker ps

# Check port conflicts
sudo netstat -tulpn | grep LISTEN

# Rebuild images
docker-compose build --no-cache
```

### Database connection errors

```bash
# Test MongoDB connection
mongosh mongodb://localhost:27017

# Test Redis connection
redis-cli ping

# Check environment variables
docker-compose exec app env | grep MONGO
```

### High memory usage

```bash
# Analyze heap
node --inspect app.js

# Check Node memory limits
docker-compose exec app node -e "console.log(require('os').totalmem())"
```

## Support & Resources

- Documentation: See README.md
- Issues: Report at GitHub Issues
- Logs: Check `/logs` directory or CloudWatch/Stackdriver
- Performance: Run `npm run analyze` for bundle analysis

## Version Management

Track deployment versions:

```bash
# Tag releases
git tag v1.0.0
git push origin v1.0.0

# Reference in docker-compose
services:
  app:
    image: registry.example.com/dhub:v1.0.0
```
