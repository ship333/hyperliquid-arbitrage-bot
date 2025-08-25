import numpy as np
import pandas as pd
from typing import Tuple

class GasPredictor:
    """
    Simple model: gas_used = a + b*size + c*size^2 (quadratic)
    Fit with numpy.polyfit; predict gas units; convert to USD outside this class.
    """
    def __init__(self):
        self.coef = None  # np.poly1d

    def fit(self, df: pd.DataFrame, size_col: str = "size", gas_col: str = "gas_used") -> None:
        if len(df) < 3:
            return
        x = df[size_col].to_numpy(dtype=float)
        y = df[gas_col].to_numpy(dtype=float)
        self.coef = np.poly1d(np.polyfit(x, y, deg=2))

    def predict_units(self, size: float) -> float:
        if self.coef is None:
            return float("nan")
        return float(self.coef(size))
