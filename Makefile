.DEFAULT_GOAL := help
SHELL := /bin/bash

# Four required services. Add optional ones with PROFILES, e.g.
#   make dev PROFILES=kicad
#   make up  PROFILES="kicad search"
PROFILES     ?=
PROFILE_ARGS := $(foreach p,$(PROFILES),--profile $(p))

COMPOSE      := docker compose $(PROFILE_ARGS)
COMPOSE_DEV  := docker compose $(PROFILE_ARGS) -f docker-compose.yml -f docker-compose.dev.yml
KICAD_SYMBOLS_REPO    := https://gitlab.com/kicad/libraries/kicad-symbols.git
KICAD_FOOTPRINTS_REPO := https://gitlab.com/kicad/libraries/kicad-footprints.git

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ------------------------------------------------------------------ local dev
.PHONY: install
install: ## Install workspace dependencies
	pnpm install

.PHONY: build
build: ## Build all packages
	pnpm build

.PHONY: test
test: ## Run the full test suite
	pnpm test:run

.PHONY: typecheck
typecheck: ## Typecheck every package
	pnpm typecheck

.PHONY: lint
lint: ## Lint and check formatting
	pnpm lint && pnpm format:check

.PHONY: check
check: typecheck lint test ## Everything CI runs

# ------------------------------------------------------------------ docker
.PHONY: env
env: ## Create .env from the example if it does not exist
	@test -f .env || (cp .env.example .env && echo "Created .env — fill in the secrets before 'make up'")

.PHONY: dev
dev: env ## Start the dev stack with hot reload (web on :3015; add PROFILES=...)
	$(COMPOSE_DEV) up --build

.PHONY: up
up: env ## Start the production-shaped stack in the background
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop the stack
	$(COMPOSE_DEV) down

.PHONY: clean
clean: ## Stop the stack and delete its volumes (destroys local data)
	$(COMPOSE_DEV) down -v

.PHONY: logs
logs: ## Tail logs from every service
	$(COMPOSE_DEV) logs -f --tail=100

.PHONY: ps
ps: ## Show service status
	$(COMPOSE_DEV) ps

.PHONY: health
health: ## Probe every service health endpoint
	@bash scripts/health-check.sh

# ------------------------------------------------------------------ data
.PHONY: kicad-libs
kicad-libs: ## Shallow-clone the KiCad symbol and footprint libraries into vendor/
	@mkdir -p vendor
	@test -d vendor/kicad-symbols || git clone --depth 1 $(KICAD_SYMBOLS_REPO) vendor/kicad-symbols
	@test -d vendor/kicad-footprints || git clone --depth 1 $(KICAD_FOOTPRINTS_REPO) vendor/kicad-footprints
	@echo "KiCad libraries ready in vendor/"

.PHONY: index-parts
index-parts: ## Rebuild the parts index (Mongo text index, or Meilisearch under `search`)
	$(COMPOSE_DEV) exec api node dist/cli.js reindex-parts
