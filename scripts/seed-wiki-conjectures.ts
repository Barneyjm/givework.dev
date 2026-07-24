import { closePool, pool } from '../src/db.js';

// Seed the full open-problems table from Wikipedia's "List of conjectures"
// (https://en.wikipedia.org/wiki/List_of_conjectures) as public `conjecture`
// targets. Idempotent (ON CONFLICT on the slug, DO NOTHING), so it's safe to
// re-run and it composes with seed-conjectures.ts — the starter set's slugs
// (collatz, goldbach, twin-primes) match, so those keep their checkers.
//
// None of these get a `checker`: the built-in auto_rerun verifiers only cover
// goldbach / euler_sum_of_powers (src/verify.ts). Everything seeded here falls
// to human review until a checker exists. statement_plain is a one-line gloss,
// not the precise formal statement — source_ref points at the full article.

interface WikiConjecture {
  slug: string;
  name: string;
  statement: string;
  /** Wikipedia article path (appended to https://en.wikipedia.org/wiki/). */
  article: string;
}

const CONJECTURES: WikiConjecture[] = [
  {
    slug: 'one-third-two-thirds',
    name: '1/3–2/3 conjecture',
    statement:
      'Every finite partially ordered set that is not totally ordered has a pair of elements x, y such that between 1/3 and 2/3 of its linear extensions place x before y.',
    article: '1/3%E2%80%932/3_conjecture',
  },
  {
    slug: 'abc',
    name: 'abc conjecture',
    statement:
      'For every ε > 0, only finitely many coprime triples a + b = c satisfy c > rad(abc)^(1+ε).',
    article: 'Abc_conjecture',
  },
  {
    slug: 'agoh-giuga',
    name: 'Agoh–Giuga conjecture',
    statement: 'An integer n > 1 is prime if and only if Σ_{k=1}^{n−1} k^(n−1) ≡ −1 (mod n).',
    article: 'Agoh%E2%80%93Giuga_conjecture',
  },
  {
    slug: 'agrawal',
    name: "Agrawal's conjecture",
    statement:
      'For coprime n and r, if (X−1)^n ≡ X^n−1 (mod n, X^r−1) then n is prime or n² ≡ 1 (mod r) — which would speed up AKS primality testing.',
    article: 'Agrawal%27s_conjecture',
  },
  {
    slug: 'andrews-curtis',
    name: 'Andrews–Curtis conjecture',
    statement:
      'Every balanced presentation of the trivial group can be reduced to the trivial presentation by Nielsen transformations, conjugation, and stabilization.',
    article: 'Andrews%E2%80%93Curtis_conjecture',
  },
  {
    slug: 'andrica',
    name: "Andrica's conjecture",
    statement: '√p_{n+1} − √p_n < 1 for every pair of consecutive primes.',
    article: 'Andrica%27s_conjecture',
  },
  {
    slug: 'artin-l-functions',
    name: 'Artin conjecture (L-functions)',
    statement:
      'The Artin L-function of every nontrivial irreducible representation of a Galois group of number fields is entire.',
    article: 'Artin_conjecture_(L-functions)',
  },
  {
    slug: 'artin-primitive-roots',
    name: "Artin's conjecture on primitive roots",
    statement:
      'Every integer that is neither −1 nor a perfect square is a primitive root modulo infinitely many primes.',
    article: 'Artin%27s_conjecture_on_primitive_roots',
  },
  {
    slug: 'bateman-horn',
    name: 'Bateman–Horn conjecture',
    statement:
      'A precise asymptotic for how often a system of irreducible polynomials takes simultaneously prime values, generalizing Hardy–Littlewood.',
    article: 'Bateman%E2%80%93Horn_conjecture',
  },
  {
    slug: 'baum-connes',
    name: 'Baum–Connes conjecture',
    statement:
      "The assembly map from a group's equivariant K-homology to the K-theory of its reduced C*-algebra is an isomorphism.",
    article: 'Baum%E2%80%93Connes_conjecture',
  },
  {
    slug: 'beal',
    name: "Beal's conjecture",
    statement:
      'If A^x + B^y = C^z with positive integers and x, y, z all greater than 2, then A, B, C share a common prime factor.',
    article: 'Beal_conjecture',
  },
  {
    slug: 'beilinson',
    name: 'Beilinson conjecture',
    statement:
      'Special values of motivic L-functions are given, up to rational factors, by regulators of motivic cohomology.',
    article: 'Beilinson_conjecture',
  },
  {
    slug: 'berry-tabor',
    name: 'Berry–Tabor conjecture',
    statement:
      'Energy levels of a generic integrable quantum system behave statistically like a Poisson process.',
    article: 'Berry%E2%80%93Tabor_conjecture',
  },
  {
    slug: 'big-line-big-clique',
    name: 'Big-line-big-clique conjecture',
    statement:
      'For all k and l, every sufficiently large finite planar point set contains l collinear points or k points that are pairwise mutually visible.',
    article: 'Big-line-big-clique_conjecture',
  },
  {
    slug: 'birch-swinnerton-dyer',
    name: 'Birch and Swinnerton-Dyer conjecture',
    statement:
      'The rank of an elliptic curve over Q equals the order of vanishing of its L-function at s = 1.',
    article: 'Birch_and_Swinnerton-Dyer_conjecture',
  },
  {
    slug: 'birch-tate',
    name: 'Birch–Tate conjecture',
    statement:
      "Relates the order of K₂ of a totally real number field's ring of integers to the value of its Dedekind zeta function at −1.",
    article: 'Birch%E2%80%93Tate_conjecture',
  },
  {
    slug: 'birkhoff-billiards',
    name: 'Birkhoff conjecture',
    statement: 'The only integrable convex billiard tables are ellipses.',
    article: 'Birkhoff_conjecture',
  },
  {
    slug: 'bloch-beilinson',
    name: 'Bloch–Beilinson conjectures',
    statement:
      'Chow groups of smooth projective varieties carry a functorial filtration controlled by the L-functions of the motive.',
    article: 'Bloch%E2%80%93Beilinson_conjectures',
  },
  {
    slug: 'bloch-kato',
    name: 'Bloch–Kato conjecture',
    statement:
      'The Tamagawa number conjecture: special values of motivic L-functions are computed by Galois cohomology via Tamagawa measures.',
    article: 'Bloch%E2%80%93Kato_conjecture',
  },
  {
    slug: 'bochner-riesz',
    name: 'Bochner–Riesz conjecture',
    statement:
      'Bochner–Riesz means of order δ > 0 are bounded on L^p(R^n) exactly when 2n/(n+1+2δ) < p < 2n/(n−1−2δ).',
    article: 'Bochner%E2%80%93Riesz_conjecture',
  },
  {
    slug: 'bombieri-lang',
    name: 'Bombieri–Lang conjecture',
    statement:
      'On a variety of general type over a number field, the rational points are not Zariski dense.',
    article: 'Bombieri%E2%80%93Lang_conjecture',
  },
  {
    slug: 'borel',
    name: 'Borel conjecture',
    statement:
      'Two closed aspherical manifolds with isomorphic fundamental groups are homeomorphic.',
    article: 'Borel_conjecture',
  },
  {
    slug: 'bost',
    name: 'Bost conjecture',
    statement:
      'The Baum–Connes-style assembly map with coefficients in the Banach algebra L¹(G) is an isomorphism.',
    article: 'Bost_conjecture',
  },
  {
    slug: 'brennan',
    name: 'Brennan conjecture',
    statement:
      'For a conformal map f of a simply connected planar domain onto the unit disk, ∫|f′|^p dA is finite for all 4/3 < p < 4.',
    article: 'Brennan_conjecture',
  },
  {
    slug: 'brocard',
    name: "Brocard's conjecture",
    statement:
      'There are at least four primes between p_n² and p_{n+1}² for every n ≥ 2 (consecutive primes squared).',
    article: 'Brocard%27s_conjecture',
  },
  {
    slug: 'brumer-stark',
    name: 'Brumer–Stark conjecture',
    statement:
      'A Stickelberger-type element built from L-values annihilates the class group of certain abelian extensions and produces Brumer–Stark units.',
    article: 'Brumer%E2%80%93Stark_conjecture',
  },
  {
    slug: 'bunyakovsky',
    name: 'Bunyakovsky conjecture',
    statement:
      'An irreducible integer polynomial with positive leading coefficient and no fixed prime divisor of its values takes infinitely many prime values.',
    article: 'Bunyakovsky_conjecture',
  },
  {
    slug: 'caratheodory',
    name: 'Carathéodory conjecture',
    statement:
      'Every sufficiently smooth closed convex surface in R³ has at least two umbilic points.',
    article: 'Carath%C3%A9odory_conjecture',
  },
  {
    slug: 'carmichael-totient',
    name: 'Carmichael totient conjecture',
    statement:
      'No value of the totient function is attained exactly once: if φ(x) = n has a solution, it has at least two.',
    article: "Carmichael's_totient_function_conjecture",
  },
  {
    slug: 'casas-alvero',
    name: 'Casas-Alvero conjecture',
    statement:
      'A degree-n complex polynomial sharing a root with each of its first n−1 derivatives is a constant times a power of a linear polynomial.',
    article: 'Casas-Alvero_conjecture',
  },
  {
    slug: 'catalan-dickson',
    name: 'Catalan–Dickson conjecture on aliquot sequences',
    statement:
      'No aliquot sequence (iterating the sum of proper divisors) diverges to infinity — all terminate or become periodic.',
    article: 'Aliquot_sequence',
  },
  {
    slug: 'catalan-mersenne',
    name: "Catalan's Mersenne conjecture",
    statement:
      'Every term of the Catalan–Mersenne sequence 2, M(2)=3, M(3)=7, M(7)=127, M(127), … (iterated Mersenne numbers) is prime.',
    article: 'Double_Mersenne_number',
  },
  {
    slug: 'cherlin-zilber',
    name: 'Cherlin–Zilber conjecture',
    statement:
      'Every infinite simple group of finite Morley rank is an algebraic group over an algebraically closed field.',
    article: 'Cherlin%E2%80%93Zilber_conjecture',
  },
  {
    slug: 'chowla',
    name: 'Chowla conjecture',
    statement:
      'Autocorrelations of the Liouville function vanish: Σ_{n≤x} λ(n+h₁)⋯λ(n+h_k) = o(x) for any distinct shifts.',
    article: 'Chowla_conjecture',
  },
  {
    slug: 'collatz',
    name: 'Collatz conjecture',
    statement:
      'For every positive integer n, iterating n → n/2 (if even) or 3n+1 (if odd) eventually reaches 1.',
    article: 'Collatz_conjecture',
  },
  {
    slug: 'cramer',
    name: "Cramér's conjecture",
    statement: 'Gaps between consecutive primes satisfy p_{n+1} − p_n = O((log p_n)²).',
    article: 'Cram%C3%A9r%27s_conjecture',
  },
  {
    slug: 'conway-thrackle',
    name: "Conway's thrackle conjecture",
    statement:
      'A thrackle (a drawing in which every pair of edges meets exactly once) has at most as many edges as vertices.',
    article: 'Thrackle',
  },
  {
    slug: 'deligne-monodromy',
    name: 'Deligne conjecture (monodromy)',
    statement:
      "One of Deligne's open conjectures on monodromy of local systems; see the source article for the precise statement.",
    article: 'Deligne_conjecture',
  },
  {
    slug: 'dittert',
    name: 'Dittert conjecture',
    statement:
      'Among nonnegative n×n matrices with entry sum n, the function ∏(row sums) + ∏(column sums) − per(A) is maximized by the matrix with all entries 1/n.',
    article: 'Dittert_conjecture',
  },
  {
    slug: 'eilenberg-ganea',
    name: 'Eilenberg–Ganea conjecture',
    statement:
      'Every group of cohomological dimension 2 admits a 2-dimensional aspherical classifying complex (no group has cd 2 but geometric dimension 3).',
    article: 'Eilenberg%E2%80%93Ganea_conjecture',
  },
  {
    slug: 'elliott-halberstam',
    name: 'Elliott–Halberstam conjecture',
    statement:
      'Primes are equidistributed in arithmetic progressions on average up to modulus x^θ for every θ < 1.',
    article: 'Elliott%E2%80%93Halberstam_conjecture',
  },
  {
    slug: 'erdos-faber-lovasz',
    name: 'Erdős–Faber–Lovász conjecture',
    statement:
      'A union of n copies of K_n, any two sharing at most one vertex, can be properly colored with n colors (proved for all large n in 2021; small cases open).',
    article: 'Erd%C5%91s%E2%80%93Faber%E2%80%93Lov%C3%A1sz_conjecture',
  },
  {
    slug: 'erdos-gyarfas',
    name: 'Erdős–Gyárfás conjecture',
    statement: 'Every graph with minimum degree 3 contains a cycle whose length is a power of 2.',
    article: 'Erd%C5%91s%E2%80%93Gy%C3%A1rf%C3%A1s_conjecture',
  },
  {
    slug: 'erdos-straus',
    name: 'Erdős–Straus conjecture',
    statement:
      'For every integer n ≥ 2, the fraction 4/n can be written as 1/x + 1/y + 1/z with positive integers x, y, z.',
    article: 'Erd%C5%91s%E2%80%93Straus_conjecture',
  },
  {
    slug: 'farrell-jones',
    name: 'Farrell–Jones conjecture',
    statement:
      'The K- and L-theoretic assembly maps for group rings, relative to virtually cyclic subgroups, are isomorphisms.',
    article: 'Farrell%E2%80%93Jones_conjecture',
  },
  {
    slug: 'filling-area',
    name: 'Filling area conjecture',
    statement:
      'The round hemisphere has the least area among surfaces that fill a closed curve of given length without introducing shortcuts between its points.',
    article: 'Filling_area_conjecture',
  },
  {
    slug: 'firoozbakht',
    name: "Firoozbakht's conjecture",
    statement: 'The sequence p_n^(1/n) (n-th root of the n-th prime) is strictly decreasing.',
    article: 'Firoozbakht%27s_conjecture',
  },
  {
    slug: 'fortune',
    name: "Fortune's conjecture",
    statement:
      'Every fortunate number (the smallest m > 1 with p_n# + m prime, p_n# the primorial) is prime.',
    article: 'Fortunate_number',
  },
  {
    slug: 'four-exponentials',
    name: 'Four exponentials conjecture',
    statement:
      'If x₁, x₂ and y₁, y₂ are each linearly independent over Q, at least one of e^(x_i y_j) is transcendental.',
    article: 'Four_exponentials_conjecture',
  },
  {
    slug: 'frankl-union-closed',
    name: 'Frankl conjecture (union-closed sets)',
    statement:
      'Every finite union-closed family of sets other than {∅} has an element belonging to at least half of the sets.',
    article: 'Union-closed_sets_conjecture',
  },
  {
    slug: 'gauss-circle',
    name: 'Gauss circle problem',
    statement:
      'The number of lattice points in a circle of radius r is πr² with error O(r^(1/2+ε)) for every ε > 0.',
    article: 'Gauss_circle_problem',
  },
  {
    slug: 'gilbert-pollak',
    name: 'Gilbert–Pollak conjecture',
    statement:
      'The Steiner ratio of the Euclidean plane is √3/2: a Steiner minimal tree is never shorter than √3/2 times the minimum spanning tree.',
    article: 'Gilbert%E2%80%93Pollak_conjecture',
  },
  {
    slug: 'gilbreath',
    name: 'Gilbreath conjecture',
    statement:
      'Iterating absolute differences on the sequence of primes always yields rows beginning with 1.',
    article: 'Gilbreath%27s_conjecture',
  },
  {
    slug: 'goldbach',
    name: "Goldbach's conjecture",
    statement: 'Every even integer greater than 2 is the sum of two primes.',
    article: 'Goldbach%27s_conjecture',
  },
  {
    slug: 'gold-partition',
    name: 'Gold partition conjecture',
    statement:
      'A strengthening of the 1/3–2/3 conjecture: every finite poset that is not a chain has a comparison splitting its linear extensions in at least the golden ratio.',
    article: '1/3%E2%80%932/3_conjecture',
  },
  {
    slug: 'goldberg-seymour',
    name: 'Goldberg–Seymour conjecture',
    statement:
      'The chromatic index of a multigraph is at most max(Δ + 1, ⌈density⌉), where the density is the natural fractional lower bound.',
    article: 'Goldberg%E2%80%93Seymour_conjecture',
  },
  {
    slug: 'goormaghtigh',
    name: 'Goormaghtigh conjecture',
    statement:
      'The only numbers with two different all-ones representations (x^m−1)/(x−1) = (y^n−1)/(y−1), x > y > 1, m, n > 2, are 31 and 8191.',
    article: 'Goormaghtigh_conjecture',
  },
  {
    slug: 'green-syzygy',
    name: "Green's conjecture",
    statement:
      'For a smooth curve, the vanishing of syzygies of the canonical embedding is governed exactly by the Clifford index (open in full generality).',
    article: 'Green%27s_conjecture',
  },
  {
    slug: 'grimm',
    name: "Grimm's conjecture",
    statement:
      'For any run of consecutive composite numbers, distinct primes can be assigned so each assigned prime divides its number.',
    article: 'Grimm%27s_conjecture',
  },
  {
    slug: 'grothendieck-katz',
    name: 'Grothendieck–Katz p-curvature conjecture',
    statement:
      'A linear differential equation whose reductions mod p have vanishing p-curvature for almost all p has a full basis of algebraic solutions.',
    article: 'Grothendieck%E2%80%93Katz_p-curvature_conjecture',
  },
  {
    slug: 'hadamard-matrices',
    name: 'Hadamard conjecture',
    statement: 'A Hadamard matrix of order 4k exists for every positive integer k.',
    article: 'Hadamard_matrix',
  },
  {
    slug: 'herzog-schonheim',
    name: 'Herzog–Schönheim conjecture',
    statement:
      'In any partition of a group into finitely many cosets of index > 1, two of the cosets have the same index.',
    article: 'Herzog%E2%80%93Sch%C3%B6nheim_conjecture',
  },
  {
    slug: 'hilbert-smith',
    name: 'Hilbert–Smith conjecture',
    statement:
      'Every locally compact group acting faithfully on a connected manifold is a Lie group (no faithful p-adic actions).',
    article: 'Hilbert%E2%80%93Smith_conjecture',
  },
  {
    slug: 'hodge',
    name: 'Hodge conjecture',
    statement:
      'On a smooth projective complex variety, every rational cohomology class of type (p,p) is a combination of classes of algebraic cycles.',
    article: 'Hodge_conjecture',
  },
  {
    slug: 'homological-conjectures',
    name: 'Homological conjectures in commutative algebra',
    statement:
      'A web of conjectures relating homological properties of local rings (direct summand, monomial, intersection theorems); several now proven via perfectoid methods, others open.',
    article: 'Homological_conjectures_in_commutative_algebra',
  },
  {
    slug: 'hopf',
    name: 'Hopf conjectures',
    statement:
      'A closed even-dimensional manifold of positive sectional curvature has positive Euler characteristic; S²×S² admits no metric of positive sectional curvature.',
    article: 'Hopf_conjecture',
  },
  {
    slug: 'ibragimov-iosifescu',
    name: 'Ibragimov–Iosifescu conjecture',
    statement:
      'The central limit theorem holds for stationary φ-mixing sequences with finite variance whose partial-sum variances tend to infinity.',
    article: 'Ibragimov%E2%80%93Iosifescu_conjecture_for_%CF%86-mixing_sequences',
  },
  {
    slug: 'invariant-subspace',
    name: 'Invariant subspace problem',
    statement:
      'Does every bounded linear operator on a separable infinite-dimensional Hilbert space have a nontrivial closed invariant subspace?',
    article: 'Invariant_subspace_problem',
  },
  {
    slug: 'jacobian',
    name: 'Jacobian conjecture',
    statement:
      'A polynomial map C^n → C^n whose Jacobian determinant is a nonzero constant has a polynomial inverse.',
    article: 'Jacobian_conjecture',
  },
  {
    slug: 'jacobson',
    name: "Jacobson's conjecture",
    statement:
      'In a two-sided Noetherian ring, the intersection of all powers of the Jacobson radical is zero.',
    article: 'Jacobson%27s_conjecture',
  },
  {
    slug: 'kaplansky',
    name: 'Kaplansky conjectures',
    statement:
      'Group rings k[G] of torsion-free groups have no nontrivial zero divisors or idempotents (the companion unit conjecture was disproven in 2021).',
    article: 'Kaplansky%27s_conjectures',
  },
  {
    slug: 'keating-snaith',
    name: 'Keating–Snaith conjecture',
    statement:
      'Random-matrix theory predicts the exact leading constant for the moments of the Riemann zeta function on the critical line.',
    article: 'Keating%E2%80%93Snaith_conjecture',
  },
  {
    slug: 'kothe',
    name: 'Köthe conjecture',
    statement: 'A ring with no nonzero nil two-sided ideal has no nonzero nil one-sided ideal.',
    article: 'K%C3%B6the_conjecture',
  },
  {
    slug: 'kung-traub',
    name: 'Kung–Traub conjecture',
    statement:
      'A multipoint iteration without memory using n function evaluations has convergence order at most 2^(n−1).',
    article: 'Kung%E2%80%93Traub_conjecture',
  },
  {
    slug: 'legendre',
    name: "Legendre's conjecture",
    statement: 'There is a prime between n² and (n+1)² for every positive integer n.',
    article: 'Legendre%27s_conjecture',
  },
  {
    slug: 'lemoine',
    name: "Lemoine's conjecture",
    statement: 'Every odd integer greater than 5 can be written as p + 2q with p and q prime.',
    article: 'Lemoine%27s_conjecture',
  },
  {
    slug: 'lenstra-pomerance-wagstaff',
    name: 'Lenstra–Pomerance–Wagstaff conjecture',
    statement:
      'There are infinitely many Mersenne primes, with the count of exponents below x growing like (e^γ / log 2) · log x.',
    article: 'Lenstra%E2%80%93Pomerance%E2%80%93Wagstaff_conjecture',
  },
  {
    slug: 'leopoldt',
    name: "Leopoldt's conjecture",
    statement:
      'The p-adic regulator of a number field is nonzero (proved for abelian fields, open in general).',
    article: 'Leopoldt%27s_conjecture',
  },
  {
    slug: 'list-coloring',
    name: 'List coloring conjecture',
    statement:
      "Every graph's list chromatic index equals its chromatic index: edges are as easy to color from lists as from a common palette.",
    article: 'List_edge-coloring',
  },
  {
    slug: 'littlewood',
    name: 'Littlewood conjecture',
    statement:
      'For any two real numbers α, β: lim inf n·‖nα‖·‖nβ‖ = 0, where ‖·‖ is distance to the nearest integer.',
    article: 'Littlewood_conjecture',
  },
  {
    slug: 'lovasz-hamiltonian',
    name: 'Lovász conjecture',
    statement: 'Every finite connected vertex-transitive graph contains a Hamiltonian path.',
    article: 'Lov%C3%A1sz_conjecture',
  },
  {
    slug: 'mnop',
    name: 'MNOP conjecture',
    statement:
      'Gromov–Witten and Donaldson–Thomas theories of a smooth projective 3-fold are equivalent after a change of variables.',
    article: 'MNOP_conjecture',
  },
  {
    slug: 'manin',
    name: 'Manin conjecture',
    statement:
      'An asymptotic formula for the number of rational points of bounded height on Fano varieties over number fields.',
    article: 'Manin_conjecture',
  },
  {
    slug: 'marshall-hall',
    name: "Marshall Hall's conjecture",
    statement:
      'For integers with x³ ≠ y², the difference satisfies |x³ − y²| > C·x^(1/2−ε) — perfect squares and cubes cannot be too close.',
    article: 'Marshall_Hall%27s_conjecture',
  },
  {
    slug: 'mazur',
    name: "Mazur's conjectures",
    statement:
      'On the topology of rational points: e.g. the real closure of the rational points of a variety over Q has finitely many connected components.',
    article: 'Mazur%27s_conjectures',
  },
  {
    slug: 'montgomery-pair-correlation',
    name: "Montgomery's pair correlation conjecture",
    statement:
      'The pair correlation of nontrivial zeros of the Riemann zeta function matches that of eigenvalues of random GUE matrices.',
    article: 'Montgomery%27s_pair_correlation_conjecture',
  },
  {
    slug: 'n-conjecture',
    name: 'n conjecture',
    statement:
      'A generalization of the abc conjecture to sums of n coprime integers a₁ + … + a_n = 0.',
    article: 'N_conjecture',
  },
  {
    slug: 'new-mersenne',
    name: 'New Mersenne conjecture',
    statement:
      'For odd p, if two of the following hold, so does the third: p = 2^k ± 1 or 4^k ± 3; 2^p − 1 is prime; (2^p + 1)/3 is prime.',
    article: 'New_Mersenne_conjecture',
  },
  {
    slug: 'novikov',
    name: 'Novikov conjecture',
    statement: 'Higher signatures of closed oriented manifolds are homotopy invariants.',
    article: 'Novikov_conjecture',
  },
  {
    slug: 'oppermann',
    name: "Oppermann's conjecture",
    statement:
      'For every n > 1 there is a prime between n² − n and n², and another between n² and n² + n.',
    article: 'Oppermann%27s_conjecture',
  },
  {
    slug: 'petersen-coloring',
    name: 'Petersen coloring conjecture',
    statement:
      'Every bridgeless cubic graph admits a Petersen coloring (an edge map to the Petersen graph preserving adjacency), implying several flow and coloring conjectures.',
    article: 'Petersen_coloring_conjecture',
  },
  {
    slug: 'pierce-birkhoff',
    name: 'Pierce–Birkhoff conjecture',
    statement:
      'Every continuous piecewise-polynomial function on R^n is a finite sup of infs of polynomials.',
    article: 'Pierce%E2%80%93Birkhoff_conjecture',
  },
  {
    slug: 'pillai',
    name: "Pillai's conjecture",
    statement:
      'For every fixed k > 0, the equation x^p − y^q = k has only finitely many solutions with exponents p, q > 1 (generalizing Catalan).',
    article: 'Pillai%27s_conjecture',
  },
  {
    slug: 'de-polignac',
    name: "De Polignac's conjecture",
    statement:
      'Every even number occurs infinitely often as a gap between consecutive primes (twin primes are the case 2).',
    article: 'Polignac%27s_conjecture',
  },
  {
    slug: 'quantum-pcp',
    name: 'Quantum PCP conjecture',
    statement:
      'Approximating the ground-state energy of a local Hamiltonian to constant relative precision is QMA-hard — a quantum analogue of the PCP theorem.',
    article: 'Quantum_PCP_conjecture',
  },
  {
    slug: 'quantum-unique-ergodicity',
    name: 'Quantum unique ergodicity conjecture',
    statement:
      'On a negatively curved compact manifold, high-energy Laplacian eigenfunctions equidistribute: the only quantum limit is the Liouville measure.',
    article: 'Quantum_ergodicity',
  },
  {
    slug: 'reconstruction',
    name: 'Reconstruction conjecture',
    statement:
      'Every graph on at least three vertices is determined up to isomorphism by its multiset of vertex-deleted subgraphs.',
    article: 'Reconstruction_conjecture',
  },
  {
    slug: 'riemann-hypothesis',
    name: 'Riemann hypothesis',
    statement: 'Every nontrivial zero of the Riemann zeta function has real part 1/2.',
    article: 'Riemann_hypothesis',
  },
  {
    slug: 'ringel-kotzig',
    name: 'Ringel–Kotzig conjecture',
    statement: 'Every tree has a graceful labeling.',
    article: 'Graceful_labeling',
  },
  {
    slug: 'rudin-squares',
    name: "Rudin's conjecture",
    statement:
      'An arithmetic progression of length N contains O(√N) perfect squares (with the extremal count achieved by a specific progression).',
    article: 'Rudin%27s_conjecture',
  },
  {
    slug: 'sarnak',
    name: 'Sarnak conjecture',
    statement:
      'The Möbius function does not correlate with any bounded sequence produced by a zero-topological-entropy dynamical system.',
    article: 'Sarnak%27s_conjecture',
  },
  {
    slug: 'sato-tate',
    name: 'Sato–Tate conjecture',
    statement:
      'Frobenius angles of an elliptic curve without complex multiplication equidistribute with respect to the sin² measure (proved over totally real fields; open in full generality).',
    article: 'Sato%E2%80%93Tate_conjecture',
  },
  {
    slug: 'schanuel',
    name: "Schanuel's conjecture",
    statement:
      'If z₁, …, z_n are linearly independent over Q, the field Q(z₁, …, z_n, e^{z₁}, …, e^{z_n}) has transcendence degree at least n.',
    article: 'Schanuel%27s_conjecture',
  },
  {
    slug: 'schinzel-h',
    name: "Schinzel's hypothesis H",
    statement:
      'Any finite set of irreducible integer polynomials with no fixed prime dividing all products takes simultaneously prime values infinitely often.',
    article: 'Schinzel%27s_hypothesis_H',
  },
  {
    slug: 'scholz',
    name: 'Scholz conjecture',
    statement: 'The shortest addition chain for 2^n − 1 satisfies l(2^n − 1) ≤ n − 1 + l(n).',
    article: 'Scholz_conjecture',
  },
  {
    slug: 'second-hardy-littlewood',
    name: 'Second Hardy–Littlewood conjecture',
    statement:
      'π(x + y) ≤ π(x) + π(y) for x, y ≥ 2 — believed incompatible with the prime k-tuples conjecture, yet unresolved.',
    article: 'Second_Hardy%E2%80%93Littlewood_conjecture',
  },
  {
    slug: 'selfridge',
    name: "Selfridge's conjecture",
    statement:
      '78,557 is the smallest Sierpiński number: the smallest odd k such that k·2^n + 1 is composite for every n.',
    article: 'Sierpi%C5%84ski_number',
  },
  {
    slug: 'sendov',
    name: "Sendov's conjecture",
    statement:
      'If all zeros of a polynomial lie in the closed unit disk, then within distance 1 of each zero lies a zero of the derivative.',
    article: 'Sendov%27s_conjecture',
  },
  {
    slug: 'serre-multiplicity',
    name: "Serre's multiplicity conjectures",
    statement:
      'Intersection multiplicities defined via Tor over regular local rings are nonnegative and vanish exactly when dimensions are deficient (partially proven).',
    article: 'Serre%27s_multiplicity_conjectures',
  },
  {
    slug: 'singmaster',
    name: "Singmaster's conjecture",
    statement:
      "There is a universal bound on how many times any number greater than 1 appears in Pascal's triangle.",
    article: 'Singmaster%27s_conjecture',
  },
  {
    slug: 'spectral-gap-ergodic',
    name: 'Spectral gap conjecture',
    statement:
      'Whether natural families of measure-preserving group actions admit a uniform spectral gap; see the source article for the precise setting.',
    article: 'Spectral_gap',
  },
  {
    slug: 'standard-conjectures',
    name: 'Standard conjectures on algebraic cycles',
    statement:
      "Grothendieck's conjectures that algebraic cycles induce the Künneth and Lefschetz decompositions in cohomology, with Hodge-type positivity.",
    article: 'Standard_conjectures_on_algebraic_cycles',
  },
  {
    slug: 'tate',
    name: 'Tate conjecture',
    statement:
      'Over a finitely generated field, Galois-invariant classes in ℓ-adic cohomology are spanned by classes of algebraic cycles.',
    article: 'Tate_conjecture',
  },
  {
    slug: 'toeplitz-square',
    name: "Toeplitz' conjecture",
    statement:
      'Every Jordan curve in the plane contains four points forming a square (the inscribed square problem).',
    article: 'Inscribed_square_problem',
  },
  {
    slug: 'tuza',
    name: "Tuza's conjecture",
    statement:
      'In any graph, the minimum number of edges covering all triangles is at most twice the maximum number of edge-disjoint triangles.',
    article: 'Tuza%27s_conjecture',
  },
  {
    slug: 'twin-primes',
    name: 'Twin prime conjecture',
    statement: 'There are infinitely many primes p such that p + 2 is also prime.',
    article: 'Twin_prime',
  },
  {
    slug: 'ulam-packing',
    name: "Ulam's packing conjecture",
    statement:
      'The ball is the convex body with the lowest optimal packing density in three-dimensional space.',
    article: 'Ulam%27s_packing_conjecture',
  },
  {
    slug: 'markov-unicity',
    name: 'Unicity conjecture for Markov numbers',
    statement:
      'Every Markov number is the largest element of exactly one Markov triple (up to ordering).',
    article: 'Markov_number',
  },
  {
    slug: 'uniformity',
    name: 'Uniformity conjecture',
    statement:
      'The number of rational points on a smooth curve of genus ≥ 2 over a number field is bounded uniformly in terms of the genus and the field.',
    article: 'Uniformity_conjecture',
  },
  {
    slug: 'unique-games',
    name: 'Unique games conjecture',
    statement:
      'Deciding near-satisfiability of unique-label-cover constraint systems is NP-hard — which would pin down the approximability of many optimization problems.',
    article: 'Unique_games_conjecture',
  },
  {
    slug: 'vandiver',
    name: "Vandiver's conjecture",
    statement:
      'The prime p does not divide the class number of the maximal real subfield of the p-th cyclotomic field.',
    article: 'Vandiver%27s_conjecture',
  },
  {
    slug: 'virasoro',
    name: 'Virasoro conjecture',
    statement:
      'The generating function of Gromov–Witten invariants of a smooth projective variety is annihilated by a half-branch of the Virasoro algebra.',
    article: 'Virasoro_conjecture',
  },
  {
    slug: 'vizing',
    name: "Vizing's conjecture",
    statement:
      'The domination number of a Cartesian product of graphs is at least the product of the domination numbers.',
    article: 'Vizing%27s_conjecture',
  },
  {
    slug: 'vojta',
    name: "Vojta's conjecture",
    statement:
      'Height inequalities for rational points on varieties generalizing Roth and Faltings; implies the abc and Bombieri–Lang conjectures.',
    article: 'Vojta%27s_conjecture',
  },
  {
    slug: 'waring',
    name: "Waring's conjecture",
    statement:
      'The ideal Waring theorem holds for every exponent: g(k) = 2^k + ⌊(3/2)^k⌋ − 2 powers suffice to represent every positive integer.',
    article: 'Waring%27s_problem',
  },
  {
    slug: 'weight-monodromy',
    name: 'Weight monodromy conjecture',
    statement:
      'For a variety over a local field, the monodromy filtration on ℓ-adic cohomology coincides with the weight filtration.',
    article: 'Weight_monodromy_conjecture',
  },
  {
    slug: 'weinstein',
    name: 'Weinstein conjecture',
    statement:
      'Every Reeb vector field on a closed contact manifold carries at least one periodic orbit (proved in dimension 3, open above).',
    article: 'Weinstein_conjecture',
  },
  {
    slug: 'whitehead-aspherical',
    name: 'Whitehead conjecture',
    statement:
      'Every connected subcomplex of an aspherical 2-dimensional CW complex is aspherical.',
    article: 'Whitehead_conjecture',
  },
  {
    slug: 'zauner',
    name: "Zauner's conjecture",
    statement:
      'A SIC-POVM (a set of d² equiangular lines) exists in complex Hilbert space of every dimension d.',
    article: 'Zauner%27s_conjecture',
  },
];

async function main() {
  let inserted = 0;
  for (const c of CONJECTURES) {
    const { rowCount } = await pool.query(
      `INSERT INTO targets (name, kind, slug, statement_plain, source_ref)
       VALUES ($1, 'conjecture', $2, $3, $4)
       ON CONFLICT (slug) WHERE slug IS NOT NULL DO NOTHING`,
      [c.name, c.slug, c.statement, `https://en.wikipedia.org/wiki/${c.article}`],
    );
    const isNew = rowCount === 1;
    if (isNew) inserted++;
    console.log(`  ${isNew ? '+' : '·'} ${c.slug.padEnd(28)} ${c.name}`);
  }
  console.log(
    `\nSeeded ${inserted} new conjecture(s) (${CONJECTURES.length - inserted} already present).`,
  );
  console.log('Source: https://en.wikipedia.org/wiki/List_of_conjectures (open problems table).');
  console.log('Public progress pages: GET /conjectures/<slug>   ·   leaderboard: GET /leaderboard');
}

main()
  .catch((err) => {
    console.error('seed-wiki-conjectures failed:', err.message ?? err);
    process.exitCode = 1;
  })
  .finally(closePool);
