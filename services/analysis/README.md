# Audiosous analysis

This is the future Python sidecar. Milestone 1 does not run it and does not depend on NumPy, librosa, or PyTorch.

The desktop UI must not import this package. When analysis starts, a Tauri command will spawn the process and exchange JSON defined by `@audiosous/analysis-contract` (`contractVersion` 1). Internal arrays stay in this process.

The importable module is `audiosous_analysis`. A capitalised directory name would not be a legal Python package.
