/-
Canary module: genuinely true theorems provable in core Lean 4 (no mathlib).
Compiled green inside the pinned lean4 sandbox image before shipping — this
file is the template's proof that the whole rail works end to end.
-/

theorem add_comm_canary (a b : Nat) : a + b = b + a := Nat.add_comm a b

theorem sum_le_double_max (a b : Nat) : a + b ≤ 2 * max a b := by
  cases Nat.le_total a b with
  | inl h =>
    calc a + b ≤ b + b := Nat.add_le_add_right h b
    _ = 2 * b := (Nat.two_mul b).symm
    _ = 2 * max a b := by rw [Nat.max_eq_right h]
  | inr h =>
    calc a + b ≤ a + a := Nat.add_le_add_left h a
    _ = 2 * a := (Nat.two_mul a).symm
    _ = 2 * max a b := by rw [Nat.max_eq_left h]

theorem small_power_check : 2 ^ 10 = 1024 := by decide
