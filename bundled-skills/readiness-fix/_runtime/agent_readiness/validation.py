"""Bounded, shared diagnostics for captured evaluation inputs."""

MAX_PROBLEMS = 50


class ValidationError(ValueError):
    def __init__(self, problems: str | list[str], *, problem_count: int | None = None):
        values = [problems] if isinstance(problems, str) else problems
        self.problems = [value.replace("\r", "\\r").replace("\n", "\\n") for value in values[:MAX_PROBLEMS]]
        self.problem_count = len(values) if problem_count is None else problem_count
        self.omitted_count = self.problem_count - len(self.problems)
        super().__init__("\n".join(self.problems))


class Problems:
    def __init__(self):
        self.items: list[str] = []
        self.count = 0

    def add(self, message: str) -> None:
        self.count += 1
        if len(self.items) < MAX_PROBLEMS:
            # One diagnostic per CLI line, even for malformed captured values.
            self.items.append(message.replace("\r", "\\r").replace("\n", "\\n"))

    def extend(self, error: ValidationError, prefix: str = "") -> None:
        for message in error.problems:
            self.add(prefix + message)
        self.count += error.omitted_count

    def raise_if_any(self, error_type: type[ValidationError]) -> None:
        if self.count:
            raise error_type(self.items, problem_count=self.count)
