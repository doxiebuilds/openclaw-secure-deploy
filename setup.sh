#!/usr/bin/env bash
# OpenClaw Setup Script
# This script prepares the host environment by creating necessary directories
# with the correct user permissions and copying configuration templates.

set -e

echo "Starting OpenClaw environment setup..."
echo "--------------------------------------"

# 1. Create Enclave Directories
echo "Checking and creating enclave directories..."
mkdir -p openclaw-enclave/workspace
mkdir -p openclaw-enclave/scripts
mkdir -p openclaw-enclave/openclaw-projects-folder/coding-projects/
mkdir -p openclaw-enclave/openclaw-secure-config
echo "[OK] Enclave directories are ready."

# 2. Setup Environment Variables
echo "Checking .env file..."
if [ ! -f ".env" ]; then
    echo "  -> .env not found. Copying from .env.example..."
    cp .env.example .env
    echo "[OK] .env file created."
else
    echo "[OK] .env file already exists."
fi

# 3. Setup OpenClaw Configuration
echo "Checking openclaw.json configuration..."
if [ ! -f "openclaw-enclave/openclaw-secure-config/openclaw.json" ]; then
    if [ -f "openclaw-enclave/openclaw-secure-config/openclaw.example.json" ]; then
        echo "  -> openclaw.json not found. Copying from openclaw.example.json..."
        cp openclaw-enclave/openclaw-secure-config/openclaw.example.json openclaw-enclave/openclaw-secure-config/openclaw.json
        echo "[OK] openclaw.json file created."
    else
        echo "[WARNING] openclaw.example.json not found in openclaw-enclave/openclaw-secure-config/."
    fi
else
    echo "[OK] openclaw.json already exists."
fi

echo "--------------------------------------"
echo "Setup Complete!"
echo "Next steps:"
echo "1. Edit the '.env' file in the root directory to add your API keys."
echo "2. Check 'openclaw-enclave/openclaw-secure-config/openclaw.json' to ensure configuration is correct."
echo "3. Run the following commands to start OpenClaw:"
echo ""
echo "   cd openclaw-docker-config"
echo "   docker-compose up -d --build"
echo ""
