# System Architecture

This document provides a deep dive into the technical architecture of the Agentic AI Builder.

## Architechtual Diagram:
```mermaid

    graph TD
    User((User))
    
    subgraph "Execution Layer (main.ts)"
        CLI[CLI Loop]
    end

    subgraph "Orchestration Layer (packages/controller)"
        Ctrl[Controller]
        DB[(Prisma / Postgres)]
    end

    subgraph "Agentic Layer (packages/agents)"
        Clar[Clarifier Agent]
        Plan[Planner Agent]
        Code[Coder Agent]
    end

    %% Flow
    User -- "Prompt" --> CLI
    CLI -- "poll status" --> Ctrl
    Ctrl -- "read/write state" --> DB
    
    Ctrl -- "Status: INIT/CLARIFYING" --> Clar
    Ctrl -- "Status: PLANNING" --> Plan
    Ctrl -- "Status: BUILDING" --> Code

    Clar -- "JSON Summary" --> DB
    Plan -- "JSON Blueprint" --> DB
    Code -- "3 Code Files" --> DB

    Code -- "Result" --> CLI
    CLI -- "Write to /output/{id}" --> FS[File System]
    FS -- "Playable Game" --> User
```

## System Flow

The system follows a linear, state-driven multi-agent orchestration pattern.

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI (main.ts)
    participant DB as Database (Prisma/Postgres)
    participant Ctrl as Controller
    participant Clr as Clarifier Agent
    participant Pln as Planner Agent
    participant Bld as Coder Agent

    User->>CLI: Prompt: "Build a Snake game"
    CLI->>DB: Create Session (Status: INIT)
    CLI->>Ctrl: start()
    Ctrl->>Clr: clarify(prompt)
    Clr->>User: Ask clarification questions
    User->>Clr: Answers
    Clr->>DB: Update Session (Summary, Status: PLANNING)
    Ctrl->>Pln: plan(requirements)
    Pln->>DB: Update Session (Plan, Status: BUILDING)
    Ctrl->>Bld: build(plan)
    Bld->>DB: Update Session (Code, Status: COMPLETED)
    Bld->>CLI: Return 3 Files
    CLI->>User: Save files to /output/{userId}/
```

## Database Schema

The database is managed via Prisma and PostgreSQL. It tracks user progress and provides a caching layer for LLM responses.

### Models

#### `User`
- **Purpose**: Generic user identity tracking.
- **Key Fields**: `id`, `name`, `email`.

#### `Session`
- **Purpose**: Tracks the lifecycle of a game building request.
- **Status Enum**:
    - `INIT`: Initial prompt received.
    - `CLARIFYING`: Agent is gathering more info.
    - `PLANNING`: Technical design in progress.
    - `BUILDING`: Code generation in progress.
    - `COMPLETED`: Game is ready.
    - `FAILED`: An error occurred.
- **Data Stores**:
    - `clarification`: JSON blob of requirements.
    - `plan`: JSON blob of technical blueprint.
    - `code`: JSON blob containing the final 3 files.

#### `LlmCache`
- **Purpose**: Saves costs and time by caching LLM responses for identical prompt hashes.

---

## Agent Intelligence

### Clarifier Agent
- **System Role**: Game Design Consultant.
- **Logic**: Uses a confidence-based threshold (0.8). If requirements are vague, it generates 2-5 questions. It keeps the summary updated in the database.

### Planner Agent
- **System Role**: Game Architect.
- **Decision Matrix**:
    - Selects **Vanilla JS** for simple tile-based or logic-based games.
    - Selects **Phaser 3** for games requiring gravity, complex physics, or collision groups.

### Coder Agent
- **System Role**: Expert JS Game Developer.
- **Constraint**: Strict instruction to produce 100% playable code without placeholders or external image assets.
