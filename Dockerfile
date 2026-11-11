FROM node:20-alpine
# Cache bust: postgres-migration-v2

# Set working directory
WORKDIR /app

# Copy root package files if any
COPY package*.json ./

# Build Frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
# Inject API url as empty so it uses the same origin
ENV VITE_API_BASE_URL=""
RUN npm run build

# Setup Backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./

# Final workspace
WORKDIR /app/backend

# Expose port 5000
EXPOSE 5000

# Start server
CMD ["npm", "start"]
