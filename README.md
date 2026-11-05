<div align="center">

<img src="./apps/web/public/images/favicon.png" alt="Dumb CRM logo" width="280" />

### A focused, multi-tenant CRM for managing customer relationships and sales workflows.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-UI-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/License-ISC-lightgrey)](LICENSE)

**[Live Demo](https://dumb-crm-bjby.onrender.com) · [Report a Bug](https://github.com/rhythm162k/Dumb_CRM/issues) · [Request a Feature](https://github.com/rhythm162k/Dumb_CRM/issues)**

</div>

---

## Overview

Dumb CRM is a lightweight customer relationship management application built to help small teams organize their customer data and sales activities without the overhead of an overly complex CRM.

It brings contacts, companies, deals, and day-to-day activities into one workspace, with an emphasis on **usability, data quality, and secure access to customer information**.

## ✨ Features

- **Customer management** — Create, update, search, and organize contacts and companies.
- **Sales pipeline** — Track deals through customizable workflow stages using a Kanban-style board.
- **Activities and tasks** — Keep notes and record calls, emails, meetings, and follow-up tasks against CRM records.
- **CSV import and export** — Import contacts with column mapping, validation, and a dry-run preview; export CRM data to CSV.
- **Workspace collaboration** — Organize data by workspace and manage members with `owner`, `admin`, and `member` roles.
- **Audit trail** — Record important data changes and review workspace activity.
- **Authentication** — Email/password authentication, Google OAuth, secure session cookies, email verification, and password reset flows.

## 🔐 Security & Data Integrity

Security is part of the application architecture, not just the login flow.

- **Multi-tenant isolation:** Workspace-scoped access is enforced in the API and backed by PostgreSQL Row-Level Security (RLS).
- **Role-based access control:** Centralized permission checks control access to workspace operations.
- **Secure sessions:** Short-lived JWT access tokens and refresh tokens are managed through HTTP-only cookies.
- **Request protection:** CORS restrictions, origin checks for state-changing requests, security headers, and rate limiting.
- **Validated input:** Shared Zod schemas validate data at the application boundary.
- **Safer CSV handling:** Import operations support validation and dry-run rollback; exports guard against spreadsheet formula injection.
- **Audit logging:** Important mutations and data operations are recorded for traceability.

## 🧱 Tech Stack

| Area              | Technologies                              |
| ----------------- | ----------------------------------------- |
| Frontend          | React, TypeScript, Vite, CSS              |
| Backend           | Node.js, Express, TypeScript              |
| Database          | PostgreSQL                                |
| ORM & migrations  | Drizzle ORM                               |
| Validation        | Zod                                       |
| Authentication    | JWT, bcrypt, Google OAuth                 |
| Architecture      | npm workspaces monorepo                   |
| Testing & quality | Vitest, TypeScript checks, GitHub Actions |

## 🏛️ Architecture

The project is organized as an npm workspaces monorepo with separate frontend and backend applications and a shared package for validation schemas, permissions, and business constants.

```mermaid
flowchart TD
    U[User] --> WEB[React + Vite Frontend]
    WEB --> API[Express + TypeScript API]
    API --> AUTH[Authentication & Authorization]
    API --> SHARED[Shared Zod Schemas & Permissions]
    API --> DB[Drizzle ORM]
    DB --> PG[(PostgreSQL)]
    PG --> RLS[Row-Level Security]
```

### Repository structure

```text
Dumb_CRM/
├── apps/
│   ├── api/          # Express backend, routes, services, database
│   └── web/          # React frontend
├── packages/
│   └── shared/       # Shared schemas, permissions, and constants
├── docker-compose.yml
├── .env.example
└── package.json
```

## 🚀 Run Locally

### Prerequisites

- Node.js 20 or later
- npm
- Docker and Docker Compose
- PostgreSQL (Docker Compose is configured for local development)

### 1. Clone the repository

```bash
git clone https://github.com/rhythm162k/Dumb_CRM.git
cd Dumb_CRM
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create your local environment file:

```bash
cp .env.example .env
```

Update the values in `.env`. At minimum, configure your PostgreSQL connection, a strong JWT secret, and the frontend origin.

```env
DATABASE_URL=postgresql://crm:crm@localhost:5433/crm
JWT_ACCESS_SECRET=replace-with-a-long-random-secret
WEB_ORIGIN=http://localhost:5173
```

Generate a secure JWT secret with:

```bash
openssl rand -base64 48
```

Optional integrations such as Google OAuth and Resend email delivery require their respective credentials. See `.env.example` for the complete configuration.

### 4. Start PostgreSQL

```bash
docker compose up db -d
```

### 5. Run database migrations

```bash
npm run db:migrate
```

### 6. Start the application

```bash
npm run dev
```

The development servers will start together:

- Frontend: `http://localhost:5173`
- API: `http://localhost:4000`

## 🧪 Quality Checks

Run the available project checks from the repository root:

```bash
npm test
npm run typecheck
npm run build
```

## 🗺️ API Structure

CRM resources are scoped to a workspace. The main resource routes follow this pattern:

```text
/api/workspaces/:workspaceId/
```

The API includes routes for:

- Contacts
- Companies
- Deals
- Activities and tasks
- Workspace membership
- Dashboard metrics
- Audit logs

Authentication and account-management endpoints are grouped under `/api/auth`.

## 💡 Design Goals

Dumb CRM was built around a few practical problems found in everyday CRM workflows:

| Problem                                   | Product decision                                                    |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Poor usability leads to low adoption      | Keep common workflows focused and avoid unnecessary complexity.     |
| Incomplete or duplicated customer records | Validate incoming data and enforce data integrity rules.            |
| Messy spreadsheet migrations              | Provide CSV mapping, preview, validation, and dry-run import.       |
| Customer data needs careful protection    | Apply authentication, role-based permissions, and tenant isolation. |
| Data gets trapped in disconnected tools   | Support CSV export and provide a structured REST API.               |

## 📌 Project Status

Dumb CRM is a deployed personal project. The live application is available through the demo link at the top of this README.

---

<div align="center">

**Built with care by [Rhythm](https://github.com/rhythm162k)**

If you find a bug or have an idea, feel free to [open an issue](https://github.com/rhythm162k/Dumb_CRM/issues).

</div>
