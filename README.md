# 📋 LiquidVault — Cross-Device Clipboard & File Transfer

A high-performance local network file and text sharing platform built with ASP.NET Core 8 and React/TypeScript + Vite, enabling seamless peer-to-peer data transfers between devices across local networks.

---

## ✨ Highlights

- **Direct Stream Uploads**: Large files stream directly to disk with real-time transfer progress, speed metrics, chunking, and upload cancellation.
- **Batch ZIP Streaming**: Dynamically aggregates multiple files into a streamed ZIP archive without staging uncompressed duplicates on disk.
- **Local Network (LAN) Sharing**: Seamless cross-device data transfer via browser with no third-party cloud dependence or account setup needed.
- **Expiring Transfers & Auto-Cleanup**: Automated background worker cleans up expired transfers and temporary files based on configurable retention schedules.
- **Transient Text Board**: Instant copy-paste text and note synchronization with clipboard fallback support for unsupported browsers.

---

## 🏗️ Architecture & Project Structure

The platform pairs a lightweight Vite React frontend with a high-throughput ASP.NET Core streaming backend:

```
┌────────────────────────────────────────────────────────┐
│            Browser Client (React + TypeScript)         │
│          Chunked file uploads & transfer monitoring    │
└───────────────────────────┬────────────────────────────┘
                            │ Vite Dev Proxy / Reverse Proxy
┌───────────────────────────▼────────────────────────────┐
│              LiquidVault.Api (ASP.NET Core 8)          │
│  - Streamed Multipart Upload Handling                  │
│  - On-the-Fly Dynamic ZIP Archiving                    │
│  - Background Expiry & Storage Retention Service       │
└───────────────────────────┬────────────────────────────┘
                            │ File Stream I/O
┌───────────────────────────▼────────────────────────────┐
│             Local Filesystem Storage (Uploads/)        │
└────────────────────────────────────────────────────────┘
```

### Project Structure

```
CLIPBOARD/
├── LiquidVault.Api/                  # ASP.NET Core 8 Streaming API
│   ├── Controllers/                  # Transfer, download, and file streaming controllers
│   ├── Models/                       # Transfer metadata, upload settings & payloads
│   ├── Services/                     # Storage service, ZIP streamer & cleanup background workers
│   ├── appsettings.json              # Configurable storage paths & size thresholds
│   └── Program.cs                    # Service registration, CORS & middleware
├── src/                              # React 18 + TypeScript Client
│   ├── components/                   # File dropzone, upload queue & text transfer boards
│   ├── lib/                          # Utility functions, clipboard handlers & API client
│   ├── App.tsx                       # Main dashboard UI
│   └── main.tsx                      # Frontend entry point
├── scripts/                          # Cross-platform orchestration scripts (run-dev.mjs)
├── run_linux.sh                      # One-click startup script for Linux
├── run_windows.ps1                   # One-click startup script for Windows PowerShell
├── package.json                      # Frontend dependencies & build configurations
└── vite.config.ts                    # Vite build & proxy settings
```

---

## 🖥️ Tech Stack

| Layer | Technologies |
|---|---|
| **Backend** | ASP.NET Core 8 Web API, C# |
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS |
| **UI Components & Icons** | Lucide React, Sonner (Toast notifications) |
| **File Processing** | Direct disk streaming, JSZip / System.IO.Compression |
| **Tooling & Scripts** | Node.js, PowerShell, Bash |

---

## 🚀 How to Run

### Prerequisites
- **.NET SDK 8.0+**
- **Node.js 18+** & **npm**

### Quick Start (Automated)
Run the automated launcher which installs dependencies, builds both projects, and starts the services:

- **Linux / macOS**:
  ```bash
  bash run_linux.sh
  ```
- **Windows (PowerShell)**:
  ```powershell
  .\run_windows.ps1
  ```
- **Windows (Git Bash)**:
  ```bash
  bash run_windows.sh
  ```

### Manual Start

1. **Start Backend API**:
   ```bash
   cd LiquidVault.Api
   dotnet run --urls http://127.0.0.1:5000
   ```

2. **Start Frontend**:
   ```bash
   npm install
   npm run dev
   ```

3. Open **http://localhost:5173** in your browser.
