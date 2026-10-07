# Marquee

**Full-stack movie & TV tracking web application**

Marquee is a web application for discovering, tracking, rating, and organizing movies and TV shows. It combines content discovery with personal watchlists, episode-level progress, statistics, custom lists, and cloud synchronization.

🌐 **Live Demo:** https://marquee-coral.vercel.app/

---

## Features

- 🎬 Movie and TV show discovery and search
- 🔎 Detailed content pages with ratings and metadata
- 📺 Episode-level TV show progress tracking
- ⭐ Personal ratings and notes
- 📋 Watchlist, Watching, and Watched libraries
- ▶️ Up Next and viewing progress
- 📅 Schedule and upcoming content
- 👤 User accounts and cloud synchronization
- 📊 Statistics, XP, levels, streaks, badges, and yearly summaries
- 📝 Custom lists with visibility and collaboration options
- 💬 Comments, likes, replies, and reporting
- 📥 CSV import support for supported movie/TV lists
- 📱 Responsive interface and Progressive Web App support
- 💾 Offline-first local storage with cloud synchronization for signed-in users

---

## Tech Stack

### Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS

### Backend & Data

- Next.js Route Handlers and Server Actions
- Supabase
- PostgreSQL
- Supabase Authentication
- Row Level Security (RLS)

### APIs & Services

- TMDB API
- OMDb API
- Vercel

### Development

- Git & GitHub
- ESLint
- Vitest
- npm
- AI-assisted development

---

## Architecture

Marquee uses a full-stack, serverless architecture built around Next.js and Supabase.

- **Next.js** handles the application, server-side logic, and API routes.
- **Supabase/PostgreSQL** stores authenticated users and synchronized application data.
- **Supabase Auth** handles user authentication.
- **TMDB and OMDb** provide movie and TV metadata and ratings.
- **Vercel** hosts the production application.
- Signed-out users can work with local browser storage, while signed-in users can synchronize their data with the cloud.

API credentials are kept server-side and are not included in the public repository.

---

## Live Demo

**https://marquee-coral.vercel.app/**

---

## Running Locally

### Requirements

- Node.js
- npm
- Supabase project
- TMDB API credentials
- OMDb API credentials

### Installation

Clone the repository:

```bash
git clone https://github.com/0TheMower0/marquee.git
cd marquee
```

Install dependencies:

```bash
npm install
```

Create a local environment file.

**Windows PowerShell:**

```powershell
Copy-Item .env.example .env.local
```

Add the required environment variables to `.env.local`.

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

---

## Testing

The project includes automated tests using **Vitest**.

Run the project's configured test command from `package.json`.

---

## Deployment

The production application is deployed with **Vercel**.

**Live application:**  
https://marquee-coral.vercel.app/

---

## Project Background

Marquee was developed as a personal full-stack web application project to gain practical experience with modern web development, databases, authentication, APIs, deployment, and application architecture.

Development was **AI-assisted**. I directed the project, reviewed implementation approaches, configured the development and deployment environment, tested functionality, and iterated on the application.

---

## License

This project is intended as a personal portfolio project.