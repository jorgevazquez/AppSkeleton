# Kernel (`src/core`)

This directory holds the plugin kernel: manifest schema/validation, the
plugin registry and loader, the capability broker, the typed event bus,
layered config, structured logging, and error isolation. See `spec.md` at
the repo root for the full design.

Deliberately empty at scaffold time — built out by the early, high-priority
entries in `feature_list.json`. Do not add ad-hoc code here outside of the
feature workflow.
