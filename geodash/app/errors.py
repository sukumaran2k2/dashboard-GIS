class IngestError(ValueError):
    """A file cannot be accepted; the message is shown to the user."""


class GeorefError(ValueError):
    """A georeferencing request is invalid; the message is shown to the user."""


class ExportError(RuntimeError):
    """An export failed; the message is shown to the user."""
