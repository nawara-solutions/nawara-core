from fastapi import FastAPI

app = FastAPI(title="ai-service")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
